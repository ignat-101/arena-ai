"""
Эмулятор автоматизации браузера (Mock Mode) для тестирования потока без запуска реального Chromium.
Имитирует авторизацию в X.com, запрос 2FA, выбор блокчейна Base и генерацию QR для Trust Wallet.
"""

import asyncio
import time
import uuid
from typing import Tuple, Optional
from src.utils.logger import logger
from src.models.order import BuyerCredentials, PaymentQR
from src.utils.qr_generator import QRGenerator


class MockXAutomationEngine:
    """
    Эмулятор браузерной автоматизации для тестирования логики Telegram-бота
    и взаимодействия с FunPay в любых средах (в т.ч. без установленного Chrome).
    """

    def __init__(self, require_2fa_by_default: bool = False):
        self.require_2fa = require_2fa_by_default
        self.is_logged_in = False
        logger.info("🧪 Инициализирован MockXAutomationEngine (эмуляция браузера Playwright)")

    async def login(self, creds: BuyerCredentials) -> Tuple[str, str, str]:
        """
        Имитирует процесс входа в аккаунт X.com.
        Если логин содержит '2fa' или включен флаг require_2fa, возвращает статус '2fa_required'.
        """
        logger.info(f"[Mock Browser] Переход на https://x.com/i/flow/login для {creds.login}...")
        await asyncio.sleep(2)
        logger.info(f"[Mock Browser] Ввод логина: {creds.login}")
        await asyncio.sleep(1)
        logger.info("[Mock Browser] Ввод пароля: ***")
        await asyncio.sleep(1)

        # Проверяем, нужна ли 2FA (для тестирования: если в логине есть '2fa' или включен флаг)
        if "2fa" in creds.login.lower() or self.require_2fa:
            logger.warning("[Mock Browser] 🚨 X.com запрашивает двухфакторную аутентификацию (2FA)!")
            hint = "электронную почту (x****@gmail.com)"
            if "sms" in creds.login.lower():
                hint = "телефон по SMS (+1****99)"
            return "2fa_required", "email", hint

        self.is_logged_in = True
        logger.info("[Mock Browser] ✅ Вход в аккаунт X.com выполнен успешно!")
        return "success", "", ""

    async def submit_2fa_code(self, code: str) -> bool:
        """Имитирует ввод 6-значного кода 2FA и проверку успешности."""
        logger.info(f"[Mock Browser] 🔐 Ввод кода подтверждения 2FA: '{code}'...")
        await asyncio.sleep(2)
        if len(code) >= 6:
            self.is_logged_in = True
            logger.info("[Mock Browser] ✅ 2FA код принят! Авторизация завершена.")
            return True
        else:
            logger.error("[Mock Browser] ❌ Код 2FA слишком короткий. Ошибка входа.")
            return False

    async def start_subscription_checkout(
        self,
        plan: str = "premium",
        tier: str = "monthly"
    ) -> Optional[PaymentQR]:
        """
        Имитирует переход к оформлению подписки, выбор Crypto -> Блокчейн Base -> Trust Wallet
        и возвращает PaymentQR с готовыми PNG-байтами для отправки в Telegram.
        """
        logger.info(f"[Mock Browser] 🛒 Переход на страницу подписки X Premium ({plan} - {tier})...")
        await asyncio.sleep(2)
        logger.info("[Mock Browser] 💳 Открытие платежного окна Stripe Checkout...")
        await asyncio.sleep(1)
        logger.info("[Mock Browser] 🌐 Выбор способа оплаты: Crypto -> Блокчейн BASE -> Trust Wallet...")
        await asyncio.sleep(1)

        # Генерируем тестовый WalletConnect URI в сети Base
        mock_wc_id = str(uuid.uuid4())
        wc_uri = (
            f"wc:{mock_wc_id}@1?bridge=https%3A%2F%2Fbridge.walletconnect.org&"
            f"key=mock_base_trust_wallet_key_{int(time.time())}"
        )

        logger.info("[Mock Browser] 📱 Генерация QR-кода оплаты в сети Base...")
        img_bytes = QRGenerator.generate_qr_image_bytes(
            data=wc_uri,
            title="BASE • TRUST WALLET",
            subtitle=f"X Premium ({plan.upper()} • {tier.upper()})"
        )

        return PaymentQR(
            uri_data=wc_uri,
            network="Base",
            wallet="Trust Wallet",
            amount_str=f"X Premium ({plan} - {tier})",
            expires_at=time.time() + 900,
            image_bytes=img_bytes
        )

    async def close(self) -> None:
        """Завершение работы эмулятора."""
        logger.info("[Mock Browser] Сессия браузера завершена.")
