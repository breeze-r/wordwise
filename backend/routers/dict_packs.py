"""词典包 API：列出 / 启用 / 停用词典包。"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import User
from services.auth import get_current_user
from services.dict_packs import list_packs, get_pack_words

router = APIRouter(prefix="/api/dict-packs", tags=["dict-packs"])


@router.get("/", summary="列出所有可用词典包")
async def list_all_packs():
    return list_packs()


@router.get("/{pack_id}/words", summary="获取词典包的单词列表")
async def get_pack_word_list(pack_id: str):
    words = get_pack_words(pack_id)
    if words is None:
        return {"error": f"词典包 '{pack_id}' 不存在"}
    return {"pack_id": pack_id, "word_count": len(words), "words": sorted(words)}
