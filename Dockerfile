# Dockerfile для запуска автоматизации X Premium & FunPay на Linux сервере / VPS
FROM mcr.microsoft.com/playwright/python:v1.42.0-jammy

# Установка рабочей директории
WORKDIR /app

# Настройка переменных окружения
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

# Установка зависимостей Python
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Установка браузера Chromium для Playwright
RUN playwright install chromium

# Копирование исходного кода проекта
COPY . .

# Создание каталогов для логов и скриншотов
RUN mkdir -p logs screenshots data

# Точка входа
ENTRYPOINT ["python3", "main.py"]
CMD ["run"]
