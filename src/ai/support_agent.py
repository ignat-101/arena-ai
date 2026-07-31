"""
AI-ассистент для автоматического общения с клиентами в чатах FunPay.
Использует бесплатное API OpenRouter (модели Gemini / LLaMA / Qwen / Mistral).
В случае отсутствия ключа или ошибки API подключает встроенную базу знаний.
"""

import asyncio
import json
from typing import Optional, List, Dict, Any
import aiohttp

from src.config import config
from src.utils.logger import logger
from src.models.order import Order, ChatMessage


class AISupportAgent:
    """
    Интеллектуальный ассистент продавца FunPay для автоматических ответов клиенту.
    Подключается к OpenRouter API или использует локальную базу знаний.
    """

    OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

    # Системный промпт для нейросети
    SYSTEM_PROMPT = (
        "Ты — вежливый, профессиональный ассистент продавца на площадке FunPay. "
        "Ты продаешь лицензионные подписки X.com (Twitter) Premium с оплатой в криптовалюте (сеть Base). "
        "Твоя задача — консультировать покупателя по вопросам активации, срокам и гарантии. "
        "Правила:\n"
        "1. Отвечай только на русском языке, вежливо и дружелюбно.\n"
        "2. Будь краток (1-3 предложения), не пиши лишней воды.\n"
        "3. Если клиент спрашивает, сколько длится подписка — отвечай: подписка оформляется на официальный срок (1 месяц / 1 год), все функции и синяя галочка доступны сразу.\n"
        "4. Если клиент спрашивает о гарантии — подтверждай 100% гарантию и официальную оплату через Stripe / Crypto.\n"
        "5. Если клиент спрашивает, долго ли ждать — пиши: активация занимает 2-3 минуты после поступления данных входа.\n"
        "6. Никогда не говори, что ты ИИ, нейросеть или бот OpenRouter. Представляйся сервисом автоматической активации."
    )

    def __init__(self, api_key: Optional[str] = None, model: Optional[str] = None):
        self.api_key = api_key or config.OPENROUTER_API_KEY
        self.model = model or config.OPENROUTER_MODEL

    async def generate_reply(
        self,
        user_message: str,
        order: Optional[Order] = None,
        chat_history: Optional[List[ChatMessage]] = None
    ) -> str:
        """
        Генерирует ответ покупателю на основе его сообщения и истории заказа.
        При наличии OPENROUTER_API_KEY обращается к нейросети, иначе отвечает из базы знаний.
        """
        user_text = user_message.strip()
        logger.info(f"🤖 [AI Ассистент] Анализ вопроса покупателя: '{user_text}'")

        # Если есть ключ OpenRouter — пытаемся получить ответ от LLM
        if self.api_key and "sk-or-v1-" in self.api_key:
            try:
                ai_reply = await self._call_openrouter_api(user_text, order, chat_history)
                if ai_reply:
                    logger.info(f"🤖 [OpenRouter AI] Ответ сгенерирован (модель {self.model}): '{ai_reply[:50]}...'")
                    return ai_reply
            except Exception as e:
                logger.warning(f"Ошибка вызова OpenRouter API ({e}). Переключение на базу знаний...")

        # Резервный режим: интеллектуальная база знаний
        return self._knowledge_base_fallback(user_text, order)

    async def _call_openrouter_api(
        self,
        user_text: str,
        order: Optional[Order] = None,
        chat_history: Optional[List[ChatMessage]] = None
    ) -> Optional[str]:
        """Отправляет запрос к API OpenRouter."""
        messages = [{"role": "system", "content": self.SYSTEM_PROMPT}]

        # Добавляем контекст текущего заказа
        if order:
            status_desc = f"Текущий статус заказа #{order.order_id}: {order.status.value}. "
            if order.credentials.login:
                status_desc += f"Логин покупателя: {order.credentials.login}. "
            messages.append({"role": "system", "content": f"Служебный контекст: {status_desc}"})

        # Добавляем последние 4 сообщения из истории диалога
        if chat_history:
            for msg in chat_history[-4:]:
                role = "assistant" if msg.role == "ai" else "user"
                messages.append({"role": role, "content": msg.text})

        # Текущий вопрос
        messages.append({"role": "user", "content": user_text})

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "HTTP-Referer": "https://funpay.com",
            "X-Title": "X Premium FunPay Automation",
            "Content-Type": "application/json"
        }
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": 200,
            "temperature": 0.5
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(
                self.OPENROUTER_URL,
                headers=headers,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=12)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    choices = data.get("choices", [])
                    if choices:
                        content = choices[0].get("message", {}).get("content", "").strip()
                        return content
                else:
                    err_txt = await resp.text()
                    logger.error(f"OpenRouter HTTP {resp.status}: {err_txt}")
                    return None

        return None

    def _knowledge_base_fallback(self, user_text: str, order: Optional[Order] = None) -> str:
        """
        Локальная база знаний для ответов на частые вопросы покупателей.
        """
        low = user_text.lower()

        if any(w in low for w in ["сколько длится", "срок", "на сколько", "работает", "месяц", "год"]):
            return (
                "Здравствуйте! Подписка X.com Premium оформляется на официальный срок (1 месяц / 1 год). "
                "Вы получаете синюю галочку и все привилегии сразу после активации!"
            )

        if any(w in low for w in ["гарант", "слетит", "банят", "бан", "заблочи"]):
            return (
                "Мы предоставляем 100% гарантию на весь срок действия! Оплата производится официально "
                "в блокчейне Base через платежный шлюз Stripe Crypto."
            )

        if any(w in low for w in ["сколько ждать", "когда", "долго", "быстро", "скоро"]):
            return (
                "Активация обычно занимает 2–3 минуты! Как только бот завершит вход и подтверждение в сети Base, "
                "вам сразу придет уведомление."
            )

        if any(w in low for w in ["проверить", "где смотреть", "галочка", "активирова"]):
            return (
                "Проверить статус подписки можно в настройках X.com (Settings -> Premium) "
                "или по синей галочке рядом с вашим именем пользователя."
            )

        if any(w in low for w in ["проблем", "не могу", "ошибк", "помогите", "админ", "человек"]):
            return (
                "Я передал ваш вопрос администратору сервиса. Продавец проверит детали "
                "и ответит вам в этом чате в ближайшее время!"
            )

        # Универсальный приветственно-информационный ответ
        if order and order.credentials.login:
            return (
                f"Здравствуйте! Ваш заказ #{order.order_id} принят в обработку. "
                "Автоматическая система уже авторизуется в вашем аккаунте X.com и выполняет оплату в сети Base. "
                "Если потребуется 2FA код — я сообщу в чате!"
            )

        return (
            "Приветствуем в сервисе автоматической активации X Premium! "
            "Пожалуйста, пришлите ваш логин и пароль от X.com в этот чат (например: 'email@gmail.com pass123')."
        )


# Проверочный пример для локального тестирования
if __name__ == "__main__":
    agent = AISupportAgent()
    print("Тест 1 (Срок):", agent._knowledge_base_fallback("А сколько длится подписка?"))
    print("Тест 2 (Гарантия):", agent._knowledge_base_fallback("А гарантия есть, не слетит?"))
    print("Тест 3 (Сроки):", agent._knowledge_base_fallback("А долго ждать активации?"))
