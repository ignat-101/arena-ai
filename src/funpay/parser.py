"""
Парсер сообщений FunPay: извлечение логина/пароля и кодов подтверждения 2FA из текста.
"""

import re
from typing import Optional, Tuple
from src.utils.logger import logger


class FunPayMessageParser:
    """Утилита для анализа текстовых сообщений от покупателей FunPay."""

    # Регулярные выражения для поиска логина и пароля в формате login:password или login;password
    CREDENTIALS_PATTERNS = [
        # 1. Явные маркеры: Логин: ... Пароль: ...
        re.compile(
            r'(?:логин|login|почта|email|user|юзернейм)\s*[:=\-]?\s*([^\s,;]+)\s*[,\n;]?\s*'
            r'(?:пароль|password|pass|пасс)\s*[:=\-]?\s*([^\s,;]+)',
            re.IGNORECASE
        ),
        # 2. Формат login:password (с почтой или юзернеймом)
        re.compile(
            r'([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|[a-zA-Z0-9_]{3,30})\s*[:;|\s]\s*([^\s]{6,50})'
        ),
    ]

    # Регулярные выражения для поиска 6-8 значных кодов подтверждения (2FA / Verification code)
    TWO_FACTOR_PATTERNS = [
        re.compile(r'(?:код|code|2fa|вот код|подтверждение)\s*[:=\-]?\s*(\d{6,8})', re.IGNORECASE),
        re.compile(r'\b(\d{6,8})\b'),
        re.compile(r'\b([A-Z0-9]{6,8})\b'),  # Альфа-цифровые коды (если X.com отправляет такой)
    ]

    @classmethod
    def extract_credentials(cls, text: str) -> Optional[Tuple[str, str]]:
        """
        Извлекает пару (логин, пароль) из сообщения покупателя.
        Возвращает кортеж (login, password) или None.
        """
        if not text:
            return None

        # Очистка текста от лишних символов
        clean_text = text.strip()

        for pattern in cls.CREDENTIALS_PATTERNS:
            match = pattern.search(clean_text)
            if match:
                login, password = match.group(1).strip(), match.group(2).strip()
                # Простейшая валидация длины
                if len(login) >= 3 and len(password) >= 4:
                    logger.debug(f"Успешно распознаны данные входа: логин={login}, пароль=***")
                    return login, password

        return None

    @classmethod
    def extract_2fa_code(cls, text: str) -> Optional[str]:
        """
        Извлекает код подтверждения 2FA из ответа покупателя.
        Возвращает строку с кодом или None.
        """
        if not text:
            return None

        clean_text = text.strip()

        for pattern in cls.TWO_FACTOR_PATTERNS:
            match = pattern.search(clean_text)
            if match:
                code = match.group(1).strip()
                # Обычно код X.com содержит 6 цифр или 8 символов (резервные коды)
                if len(code) in (6, 7, 8):
                    logger.debug(f"Успешно распознан код 2FA: {code}")
                    return code

        return None


# Проверочный пример
if __name__ == "__main__":
    test_msg_1 = "Привет! Вот данные: my_twitter_user@gmail.com : Password!2026"
    print("Тест 1:", FunPayMessageParser.extract_credentials(test_msg_1))

    test_msg_2 = "логин: cool_crypto_user, пароль: super_secret_99"
    print("Тест 2:", FunPayMessageParser.extract_credentials(test_msg_2))

    test_msg_3 = "код пришел 839201"
    print("Тест 3 (2FA):", FunPayMessageParser.extract_2fa_code(test_msg_3))
