"""
Модели данных: Order, OrderStatus, BuyerCredentials, PaymentQR, TwoFactorRequest, OnChainTransaction.
"""

import time
import json
from enum import Enum
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, Field


class OrderStatus(str, Enum):
    """Статусы жизненного цикла заказа на покупку подписки X Premium."""
    NEW = "new"                             # Новый заказ, логин и пароль получены
    LOGGING_IN = "logging_in"               # Вход в аккаунт X.com в браузере
    WAITING_2FA = "waiting_2fa"             # Ожидание 2FA кода от покупателя
    NAVIGATING_CHECKOUT = "checkout"        # Переход на страницу оплаты Stripe
    PAYING_ON_CHAIN = "paying_on_chain"     # Автоматическое выполнение транзакции в сети Base
    WAITING_PAYMENT = "waiting_payment"     # QR код отправлен, ожидается ручная оплата
    COMPLETED = "completed"                 # Оплата успешна, покупатель уведомлен
    CANCELLED = "cancelled"                 # Заказ отменен
    ERROR = "error"                         # Произошла ошибка


class BuyerCredentials(BaseModel):
    """Данные авторизации пользователя X.com, полученные с FunPay."""
    login: str = Field(description="Логин (имя пользователя, почта или телефон)")
    password: str = Field(description="Пароль от аккаунта X.com")
    extra_username: Optional[str] = Field(
        default=None,
        description="Дополнительный юзернейм (если X запрашивает подтверждение аккаунта)"
    )


class TwoFactorRequest(BaseModel):
    """Данные запроса двухфакторной аутентификации (2FA)."""
    challenge_type: str = Field(default="email", description="Тип 2FA: email, sms, totp, security_code")
    destination_hint: str = Field(default="", description="Подсказка (например, x****@gmail.com)")
    code_received: Optional[str] = Field(default=None, description="Полученный от покупателя 2FA-код")
    requested_at: float = Field(default_factory=time.time)


class PaymentQR(BaseModel):
    """Информация о платежном QR-коде или URI оплаты (Stripe Crypto -> Base -> Trust Wallet)."""
    uri_data: str = Field(description="Сырые данные для оплаты (WalletConnect / Stripe Crypto URL)")
    network: str = Field(default="Base", description="Блокчейн-сеть (Base)")
    wallet: str = Field(default="Trust Wallet", description="Целевой кошелек")
    amount_str: str = Field(default="X Premium", description="Сумма к оплате / План")
    expires_at: float = Field(default_factory=lambda: time.time() + 900, description="Время истечения ссылки")
    image_bytes: Optional[bytes] = Field(default=None, exclude=True, description="Байты PNG изображения QR-кода")

    class Config:
        arbitrary_types_allowed = True


class ChatMessage(BaseModel):
    """Сообщение в чате FunPay (от покупателя или от AI ассистента)."""
    role: str = Field(description="Роль отправителя: 'buyer', 'ai', 'system'")
    text: str = Field(description="Текст сообщения")
    timestamp: float = Field(default_factory=time.time)


class Order(BaseModel):
    """Основная модель заказа FunPay на автоматическую активацию подписки X Premium."""
    order_id: str = Field(description="Идентификатор заказа на FunPay или сгенерированный ID")
    funpay_chat_id: int = Field(description="ID чата FunPay для отправки сообщений покупателю")
    buyer_username: str = Field(default="Клиент", description="Имя покупателя на FunPay")
    status: OrderStatus = Field(default=OrderStatus.NEW, description="Текущий статус заказа")
    credentials: BuyerCredentials
    two_factor: Optional[TwoFactorRequest] = None
    payment_qr: Optional[PaymentQR] = None
    
    # Учет ончейн-транзакций и финансов
    tx_hash: Optional[str] = Field(default=None, description="Хэш транзакции в сети Base (0x...)")
    amount_crypto: str = Field(default="0.0035 ETH", description="Сумма оплаты в криптовалюте")
    amount_usd: float = Field(default=8.00, description="Расчетная стоимость в USD")
    profit_usd: float = Field(default=3.50, description="Расчетная чистая прибыль в USD")
    payment_method: str = Field(default="base_automatic", description="Метод: base_automatic, trust_wallet_qr")
    
    # История общения AI-ассистента с клиентом
    chat_history: List[ChatMessage] = Field(default_factory=list, description="Лог диалога в чате FunPay")

    error_message: Optional[str] = None
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)

    def set_status(self, new_status: OrderStatus, error: Optional[str] = None) -> None:
        """Обновляет статус заказа и время последней активности."""
        self.status = new_status
        self.error_message = error
        self.updated_at = time.time()

    def add_chat_message(self, role: str, text: str) -> None:
        """Добавляет сообщение в историю чата заказа."""
        self.chat_history.append(ChatMessage(role=role, text=text, timestamp=time.time()))
        self.updated_at = time.time()

    def to_db_dict(self) -> Dict[str, Any]:
        """Преобразует модель в словарь для сохранения в базу данных."""
        return {
            "order_id": self.order_id,
            "funpay_chat_id": self.funpay_chat_id,
            "buyer_username": self.buyer_username,
            "status": self.status.value,
            "login": self.credentials.login,
            "password": self.credentials.password,
            "extra_username": self.credentials.extra_username or "",
            "two_factor_type": self.two_factor.challenge_type if self.two_factor else "",
            "two_factor_hint": self.two_factor.destination_hint if self.two_factor else "",
            "two_factor_code": self.two_factor.code_received if self.two_factor else "",
            "qr_uri": self.payment_qr.uri_data if self.payment_qr else "",
            "tx_hash": self.tx_hash or "",
            "amount_crypto": self.amount_crypto,
            "amount_usd": self.amount_usd,
            "profit_usd": self.profit_usd,
            "payment_method": self.payment_method,
            "chat_history_json": json.dumps([m.model_dump() for m in self.chat_history], ensure_ascii=False),
            "error_message": self.error_message or "",
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_db_dict(cls, data: Dict[str, Any]) -> "Order":
        """Восстанавливает объект заказа из записи в БД."""
        creds = BuyerCredentials(
            login=data["login"],
            password=data["password"],
            extra_username=data["extra_username"] if data.get("extra_username") else None
        )

        two_factor = None
        if data.get("two_factor_type"):
            two_factor = TwoFactorRequest(
                challenge_type=data["two_factor_type"],
                destination_hint=data["two_factor_hint"],
                code_received=data["two_factor_code"] if data.get("two_factor_code") else None
            )

        payment_qr = None
        if data.get("qr_uri"):
            payment_qr = PaymentQR(
                uri_data=data["qr_uri"],
                network="Base",
                wallet="Trust Wallet"
            )

        chat_hist = []
        if data.get("chat_history_json"):
            try:
                raw_list = json.loads(data["chat_history_json"])
                chat_hist = [ChatMessage(**item) for item in raw_list]
            except Exception:
                chat_hist = []

        return cls(
            order_id=str(data["order_id"]),
            funpay_chat_id=int(data["funpay_chat_id"]),
            buyer_username=data["buyer_username"],
            status=OrderStatus(data["status"]),
            credentials=creds,
            two_factor=two_factor,
            payment_qr=payment_qr,
            tx_hash=data.get("tx_hash") or None,
            amount_crypto=data.get("amount_crypto", "0.0035 ETH"),
            amount_usd=float(data.get("amount_usd", 8.00)),
            profit_usd=float(data.get("profit_usd", 3.50)),
            payment_method=data.get("payment_method", "base_automatic"),
            chat_history=chat_hist,
            error_message=data.get("error_message") or None,
            created_at=float(data["created_at"]),
            updated_at=float(data["updated_at"])
        )
