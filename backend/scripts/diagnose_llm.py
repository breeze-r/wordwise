"""
LLM 连接稳定性诊断脚本。
跑 5 类测试，定位"断链"问题的根因：
  1. 基础连通 — 能否单次成功？
  2. 流式稳定性 — 10 次连续流式调用，统计失败率与首字节时间
  3. 长文本 — 模拟真实 3500 字符摘要
  4. 并发 — 5 个并发请求是否相互拖累
  5. 快速串行 — 触发 rate limit 边界

用法：
  python3 scripts/diagnose_llm.py \\
    --url https://integrate.api.nvidia.com/v1/chat/completions \\
    --key nvapi-xxx \\
    --model deepseek-ai/deepseek-v4-flash
"""
import argparse
import asyncio
import json
import statistics
import time
from dataclasses import dataclass, field

import httpx


@dataclass
class Result:
    ok: bool
    status: int = 0
    first_byte: float = 0.0
    total: float = 0.0
    bytes_received: int = 0
    error: str = ""
    finish_reason: str = ""


async def single_chat(url: str, key: str, model: str, prompt: str, *, stream: bool = False, timeout: float = 60.0) -> Result:
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 200,
        "temperature": 0.1,
        "stream": stream,
    }
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if stream else "application/json",
    }
    t0 = time.monotonic()
    t_first = 0.0
    bytes_recv = 0
    finish_reason = ""

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10.0)) as client:
            if stream:
                async with client.stream("POST", url, headers=headers, json=payload) as resp:
                    if resp.status_code >= 400:
                        body = (await resp.aread()).decode("utf-8", errors="replace")[:300]
                        return Result(ok=False, status=resp.status_code, error=body, total=time.monotonic() - t0)
                    async for line in resp.aiter_lines():
                        if t_first == 0.0:
                            t_first = time.monotonic() - t0
                        if line:
                            bytes_recv += len(line)
                            if line.startswith("data:"):
                                ds = line[5:].strip()
                                if ds == "[DONE]":
                                    break
                                try:
                                    chunk = json.loads(ds)
                                    fr = chunk["choices"][0].get("finish_reason")
                                    if fr:
                                        finish_reason = fr
                                except Exception:
                                    pass
                return Result(ok=True, status=200, first_byte=t_first, total=time.monotonic() - t0,
                              bytes_received=bytes_recv, finish_reason=finish_reason)
            else:
                resp = await client.post(url, headers=headers, json=payload)
                t_first = time.monotonic() - t0
                if resp.status_code >= 400:
                    return Result(ok=False, status=resp.status_code, error=resp.text[:300], total=time.monotonic() - t0)
                data = resp.json()
                fr = data["choices"][0].get("finish_reason", "")
                return Result(ok=True, status=200, first_byte=t_first, total=time.monotonic() - t0,
                              bytes_received=len(resp.content), finish_reason=fr)
    except httpx.TimeoutException as e:
        return Result(ok=False, error=f"TIMEOUT: {type(e).__name__}: {e}", total=time.monotonic() - t0)
    except httpx.ReadError as e:
        return Result(ok=False, error=f"READ_ERROR (connection dropped mid-stream): {e}", total=time.monotonic() - t0)
    except httpx.ConnectError as e:
        return Result(ok=False, error=f"CONNECT_ERROR: {e}", total=time.monotonic() - t0)
    except Exception as e:
        return Result(ok=False, error=f"{type(e).__name__}: {e}", total=time.monotonic() - t0)


def fmt(r: Result) -> str:
    if r.ok:
        return f"OK    status={r.status}  first_byte={r.first_byte:.2f}s  total={r.total:.2f}s  bytes={r.bytes_received}  finish={r.finish_reason}"
    return f"FAIL  status={r.status}  total={r.total:.2f}s  err={r.error[:100]}"


async def test_1_basic(url: str, key: str, model: str):
    print("\n=== Test 1: 基础连通（非流式）===")
    r = await single_chat(url, key, model, "Say 'hello' in 5 words.", stream=False, timeout=30.0)
    print(fmt(r))
    return r.ok


async def test_2_stream_stability(url: str, key: str, model: str, n: int = 10):
    print(f"\n=== Test 2: 流式稳定性（连续 {n} 次）===")
    fails = []
    first_bytes = []
    totals = []
    for i in range(n):
        r = await single_chat(url, key, model, "Generate one short sentence in English.", stream=True, timeout=45.0)
        print(f"  [{i+1:02d}] {fmt(r)}")
        if r.ok:
            first_bytes.append(r.first_byte)
            totals.append(r.total)
        else:
            fails.append((i + 1, r.error[:80]))
    print(f"\n  汇总: 成功 {n - len(fails)}/{n}")
    if first_bytes:
        print(f"  首字节: avg={statistics.mean(first_bytes):.2f}s  p95={sorted(first_bytes)[int(len(first_bytes)*0.95)-1]:.2f}s")
        print(f"  总耗时: avg={statistics.mean(totals):.2f}s  max={max(totals):.2f}s")
    if fails:
        print(f"  失败明细:")
        for idx, err in fails:
            print(f"    #{idx}: {err}")
    return len(fails)


async def test_3_long_content(url: str, key: str, model: str):
    print("\n=== Test 3: 长文本流式（3500 字符 article）===")
    article = (
        "The global economy in 2026 is navigating an unprecedented confluence of challenges. "
        "Inflation, while moderating from peak levels, remains stubbornly above central bank targets in many advanced economies. "
        "Meanwhile, geopolitical tensions in the Middle East and ongoing trade frictions between major powers continue to weigh on supply chains. "
        "Artificial intelligence has emerged as both a transformative force and a source of disruption, with productivity gains in some sectors offsetting widespread job displacement in others. "
    ) * 8  # ~3500 chars
    article = article[:3500]
    prompt = f"Summarize this in 3 bullet points (English). Article:\n{article}"
    r = await single_chat(url, key, model, prompt, stream=True, timeout=60.0)
    print(fmt(r))
    return r.ok


async def test_4_concurrent(url: str, key: str, model: str, n: int = 5):
    print(f"\n=== Test 4: 并发（{n} 个流式请求同时发起）===")
    t0 = time.monotonic()
    results = await asyncio.gather(*[
        single_chat(url, key, model, f"Say number {i} in English.", stream=True, timeout=45.0)
        for i in range(n)
    ])
    wall = time.monotonic() - t0
    fails = sum(1 for r in results if not r.ok)
    print(f"  墙钟耗时: {wall:.2f}s  成功: {n - fails}/{n}")
    for i, r in enumerate(results):
        print(f"  [{i+1}] {fmt(r)}")
    return fails


async def test_5_rapid_serial(url: str, key: str, model: str, n: int = 8):
    print(f"\n=== Test 5: 快速串行（{n} 次无间隔，探 rate limit）===")
    fails = []
    for i in range(n):
        r = await single_chat(url, key, model, "hi", stream=False, timeout=15.0)
        marker = "✓" if r.ok else "✗"
        print(f"  [{i+1:02d}] {marker} status={r.status}  total={r.total:.2f}s  {r.error[:80] if not r.ok else ''}")
        if not r.ok:
            fails.append((i + 1, r.status, r.error[:80]))
    rate_limited = [f for f in fails if f[1] == 429]
    print(f"\n  汇总: 失败 {len(fails)}/{n}")
    if rate_limited:
        print(f"  ⚠️  触发 rate limit ({len(rate_limited)} 次)")
    return fails


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--skip-rate-test", action="store_true")
    args = parser.parse_args()

    print("=" * 60)
    print(f"目标: {args.url}")
    print(f"模型: {args.model}")
    print(f"Key:  {args.key[:12]}...")
    print("=" * 60)

    if not await test_1_basic(args.url, args.key, args.model):
        print("\n❌ 基础连通失败，后续测试无意义。检查 URL / Key / 模型名。")
        return

    await test_2_stream_stability(args.url, args.key, args.model, n=10)
    await test_3_long_content(args.url, args.key, args.model)
    await test_4_concurrent(args.url, args.key, args.model, n=5)
    if not args.skip_rate_test:
        await test_5_rapid_serial(args.url, args.key, args.model, n=8)

    print("\n" + "=" * 60)
    print("诊断完成。常见模式：")
    print("  • 基础通过 + 流式高失败率 → 提供商不支持稳定流式 / 中间代理缓冲")
    print("  • 流式低失败率 + 长文本失败 → 模型上下文太短 或 timeout 过短")
    print("  • 并发明显变慢 → 提供商账户并发限额")
    print("  • 快速串行触发 429 → 你的 RPM/RPS 超过了配额")
    print("  • TIMEOUT 集中出现 → 网络抖动 / 模型冷启动")
    print("  • READ_ERROR 集中 → TCP 连接被中间设备 reset（GFW / 代理）")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
