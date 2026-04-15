from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from database import init_db
from routers import auth, vocabulary, review, test, reading, dict_packs


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(
    title="WordWise API",
    description="个性化网页阅读辅助 + 动态词汇画像 + 间隔重复背词系统",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # MVP: allow all; production should restrict
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(vocabulary.router)
app.include_router(review.router)
app.include_router(test.router)
app.include_router(reading.router)
app.include_router(dict_packs.router)


@app.get("/")
async def root():
    return {
        "name": "WordWise API",
        "version": "0.1.0",
        "docs": "/docs",
    }
