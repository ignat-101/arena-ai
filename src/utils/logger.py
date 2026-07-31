"""
Модуль логирования с цветным выводом в консоль и записью в файл.
"""

import logging
import os
import sys
from pathlib import Path
from colorlog import ColoredFormatter

# Создаем директорию для логов при необходимости
LOG_DIR = Path("logs")
LOG_DIR.mkdir(exist_ok=True)
LOG_FILE = LOG_DIR / "automation.log"


def setup_logger(name: str = "XPremiumBot", level: int = logging.INFO) -> logging.Logger:
    """
    Настраивает логгер с красивым цветным форматированием в консоли
    и записью в файл.
    """
    logger = logging.getLogger(name)
    logger.setLevel(level)

    # Если хэндлеры уже добавлены, не дублируем
    if logger.handlers:
        return logger

    # --- Консольный хэндлер с цветами ---
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_formatter = ColoredFormatter(
        "%(log_color)s%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%H:%M:%S",
        reset=True,
        log_colors={
            "DEBUG": "cyan",
            "INFO": "green",
            "WARNING": "yellow",
            "ERROR": "red",
            "CRITICAL": "red,bg_white",
        },
    )
    console_handler.setFormatter(console_formatter)
    logger.addHandler(console_handler)

    # --- Файловый хэндлер (UTF-8) ---
    try:
        file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
        file_handler.setLevel(logging.DEBUG)
        file_formatter = logging.Formatter(
            "%(asctime)s | %(levelname)-8s | %(name)s | %(filename)s:%(lineno)d | %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
        file_handler.setFormatter(file_formatter)
        logger.addHandler(file_handler)
    except Exception as e:
        print(f"Не удалось настроить файловый логгер: {e}")

    return logger


logger = setup_logger()
