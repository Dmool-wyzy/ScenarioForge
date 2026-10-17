import os
from pathlib import Path

from dotenv import load_dotenv, dotenv_values

load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

MODEL_KEYS = {"OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_MODE", "SCENARIOFORGE_MODEL", "MODEL_TIMEOUT_SECONDS"}


def model_setting(name: str, default: str = "") -> str:
    file = os.getenv("SCENARIOFORGE_ENV_FILE", str(Path(__file__).resolve().parent.parent / ".env.local"))
    if file and name in MODEL_KEYS:
        path = Path(file)
        if "SCENARIOFORGE_ENV_FILE" in os.environ and not path.is_file():
            raise ValueError("无法读取项目模型配置文件，请检查 SCENARIOFORGE_ENV_FILE。")
        values = dotenv_values(path, interpolate=False) if path.is_file() else {}
        if name in values:
            return values[name] or ""
    return os.getenv(name, default)


def required(name: str) -> str:
    value = model_setting(name).strip()
    if not value or value.startswith(("sk-your-", "tvly-your-", "replace-with-")):
        raise ValueError(f"环境变量缺失或无效：{name}。请检查项目根目录的 .env.local。")
    return value


def model_name() -> str:
    return required("SCENARIOFORGE_MODEL")


def backend_url() -> str:
    return os.getenv("SCENARIOFORGE_BACKEND_URL", "http://localhost:3000").rstrip("/")
