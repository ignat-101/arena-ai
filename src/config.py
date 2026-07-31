"""
Модуль конфигурации проекта v2.0. Загружает параметры из .env или переменных окружения.
Поддерживает настройки AI (OpenRouter), авто-оплату в Base и Web-дашборд.
"""

import os
from typing import List, Optional
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppConfig(BaseSettings):
    """Настройки автоматизации X.com Premium, FunPay, AI OpenRouter & Base Crypto."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

    # --- Настройки Telegram Бота ---
    TELEGRAM_BOT_TOKEN: str = Field(default="", description="Токен Telegram бота от @BotFather")
    TELEGRAM_ADMIN_IDS: str = Field(default="", description="ID администраторов Telegram через запятую")

    # --- Настройки FunPay ---
    FUNPAY_GOLDEN_KEY: str = Field(default="", description="Cookie golden_key или PHPSESSID от FunPay")
    FUNPAY_USER_AGENT: str = Field(
        default="Mozilla/53.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        description="User-Agent для FunPay API"
    )
    FUNPAY_POLL_INTERVAL: int = Field(default=5, description="Интервал опроса FunPay (в секундах)")
    AUTO_RESPOND_FUNPAY: bool = Field(default=True, description="Автоматически отвечать покупателю в чате FunPay")

    # --- Настройки AI Ассистента (OpenRouter API) ---
    OPENROUTER_API_KEY: str = Field(default="", description="API ключ OpenRouter")
    OPENROUTER_MODEL: str = Field(
        default="google/gemini-2.0-flash-lite-preview-02-05:free",
        description="Бесплатная LLM модель OpenRouter"
    )

    # --- Настройки автоматической оплаты в сети Base ---
    AUTOMATIC_CRYPTO_PAYMENT: bool = Field(
        default=True,
        description="Полная автоматизация оплаты без ручного сканирования QR"
    )
    SELLER_WALLET_PRIVATE_KEY: str = Field(default="", description="Приватный ключ кошелька продавца в Base")
    BASE_RPC_URL: str = Field(default="https://mainnet.base.org", description="RPC Base Mainnet")
    USE_MOCK_CRYPTO: bool = Field(
        default=True,
        description="Использовать эмуляцию ончейн-транзакций (безопасный режим)"
    )

    # --- Настройки подписки X.com ---
    X_SUBSCRIPTION_PLAN: str = Field(default="premium", description="План: premium_basic, premium, premium_plus")
    X_SUBSCRIPTION_TIER: str = Field(default="monthly", description="Период: monthly или annual")
    BLOCKCHAIN_NETWORK: str = Field(default="Base", description="Сеть блокчейна (Base)")
    WALLET_TYPE: str = Field(default="Trust Wallet", description="Тип кошелька")
    CRYPTO_CURRENCY: str = Field(default="ETH", description="Валюта (ETH, USDC, USDT)")

    # --- Настройки Web Дашборда и Симулятора ---
    WEB_HOST: str = Field(default="0.0.0.0", description="Хост Web сервера")
    WEB_PORT: int = Field(default=8000, description="Порт Web сервера")

    # --- Настройки Playwright и БД ---
    PLAYWRIGHT_HEADLESS: bool = Field(default=False, description="Запуск браузера в фоновом режиме")
    BROWSER_TIMEOUT: int = Field(default=60, description="Тайм-аут операций в браузере (сек)")
    PLAYWRIGHT_PROXY: Optional[str] = Field(default=None, description="Прокси (опционально)")
    USE_MOCK_FUNPAY: bool = Field(default=False, description="Эмуляция заказов FunPay")
    USE_MOCK_BROWSER: bool = Field(default=False, description="Эмуляция браузера Playwright (для тестов/отладки)")
    DATABASE_PATH: str = Field(default="data/orders.db", description="Путь к SQLite БД")

    @property
    def admin_ids_list(self) -> List[int]:
        """Возвращает список ID администраторов Telegram в виде целых чисел."""
        if not self.TELEGRAM_ADMIN_IDS:
            return []
        ids = []
        for part in self.TELEGRAM_ADMIN_IDS.split(","):
            part = part.strip()
            if part.isdigit():
                ids.append(int(part))
        return ids

    def validate_essential_settings(self) -> List[str]:
        """
        Проверяет наличие критических настроек для боевого запуска.
        """
        warnings = []
        if not self.TELEGRAM_BOT_TOKEN:
            warnings.append("⚠️ TELEGRAM_BOT_TOKEN не установлен. Telegram-бот будет работать в консольном режиме.")
        if not self.admin_ids_list:
            warnings.append("⚠️ TELEGRAM_ADMIN_IDS не установлен или пуст.")
        if not self.FUNPAY_GOLDEN_KEY and not self.USE_MOCK_FUNPAY:
            warnings.append("⚠️ FUNPAY_GOLDEN_KEY не установлен. Для тестирования включите USE_MOCK_FUNPAY=true.")
        if self.AUTOMATIC_CRYPTO_PAYMENT and not self.USE_MOCK_CRYPTO and not self.SELLER_WALLET_PRIVATE_KEY:
            warnings.append("⚠️ AUTOMATIC_CRYPTO_PAYMENT=true, но SELLER_WALLET_PRIVATE_KEY пуст. Включите USE_MOCK_CRYPTO=true для симуляции транзакций в Base.")
        if not self.OPENROUTER_API_KEY:
            warnings.append("ℹ️ OPENROUTER_API_KEY не установлен. AI-поддержка использует встроенную базу знаний.")
        return warnings


# Глобальный экземпляр конфигурации
config = AppConfig()
