# 🚀 X.com Premium FunPay Automation v2.0 (Base Auto-Pay • OpenRouter AI • Web Dashboard)

Полнофункциональная автоматизированная система **X.com (Twitter) Premium** для продавцов на **FunPay** с **полностью автоматической ончейн-оплатой в сети Base**, **интеллектуальным AI-ассистентом поддержки через OpenRouter API** и **Web-дашбордом на FastAPI** для мониторинга, симуляций и управления.

---

## ✨ Что нового в версии 2.0 (Full Auto & AI Engine)

1. **⚡ Полностью автоматическая оплата в сети Base (`src/crypto/base_payer.py`)**
   - Больше не нужно сканировать QR-код! Система автоматически формирует, подписывает и отправляет транзакции в сети **Base Mainnet** (`Chain ID: 8453`) через `web3.py`.
   - Включается параметром `AUTOMATIC_CRYPTO_PAYMENT=true` в `.env`.
   - Поддерживает безопасный режим эмуляции ончейн-транзакций (`USE_MOCK_CRYPTO=true`) для тестирования без реальных списаний.

2. **🤖 AI-Ассистент продавца в чате FunPay (`src/ai/support_agent.py`)**
   - Автоматически общается с покупателями в чатах FunPay: консультирует по срокам подписки, гарантиям и статусу выполнения заказа.
   - Подключается к бесплатным LLM через **OpenRouter API** (`google/gemini-2.0-flash-lite-preview-02-05:free` или `meta-llama/llama-3.3-70b-instruct:free`).
   - При отсутствии API-ключа автоматически включает интеллектуальную локальную базу знаний.
   - Ведет лог каждого диалога и сохраняет историю в базу данных.

3. **🌐 Web-Дашборд и интерактивный симулятор на FastAPI (`src/web/`)**
   - Красивый темный интерфейс на **Tailwind CSS**, доступный в браузере по адресу `http://localhost:8000/`.
   - **Карточки KPI и финансовая статистика**: общий оборот, количество ончейн-транзакций в Base и чистая прибыль.
   - **Симулятор заказа**: мгновенный запуск теста авторизации X.com с возможностью эмуляции запроса 2FA и проверки авто-оплаты в Base.
   - **Интерактивный чат FunPay**: возможность выбрать любой заказ и вести диалог с AI-ассистентом прямо на сайте, а также отправлять 2FA-коды, если аккаунт требует проверку.

4. **📱 Расширенное управление через Telegram Bot (`src/telegram/bot.py`)**
   - Уведомления об успешных авто-транзакциях в сети Base с указанием хэша транзакции (`0x...`), суммы в криптовалюте и чистой прибыли.
   - Новые команды:  
     - `/stats` — просмотр финансовой статистики и учета сделок в Base.  
     - `/status` — список активных заказов.  
     - `/2fa <id> <код>` — ручной ввод кода 2FA.

---

## 🏗️ Структура проекта v2.0

```text
├── main.py                          # Главная CLI точка входа (run, web, stats, test-order)
├── test_pipeline.py                 # Автоматизированные тесты автоматизации (Unit & Integration)
├── test_web_api.py                  # Автоматизированные тесты Web-дашборда FastAPI
├── .env.example                     # Шаблон конфигурации v2.0
├── Dockerfile & docker-compose.yml  # Развертывание в Docker для Linux / VPS
├── requirements.txt                 # Зависимости Python
├── pyproject.toml                   # Спецификация пакета
└── src/
    ├── ai/                          # AI ассистент OpenRouter & локальная база знаний
    ├── crypto/                      # Движок автоматической оплаты в блокчейне Base (web3.py)
    ├── web/                         # Web-дашборд FastAPI, шаблоны и симулятор чата
    ├── funpay/                      # Асинхронный клиент FunPay и парсер сообщений
    ├── x_automation/                # Playwright браузер, Login и Checkout хэндлеры
    ├── telegram/                    # aiogram v3 Telegram-бот для продавцов
    ├── services/                    # Центральный оркестратор автоматизации
    ├── models/                      # Модели данных Pydantic и SQLite репозиторий с миграциями
    └── utils/                       # Цветное логирование и генератор PNG QR-кодов
```

---

## 🚀 Быстрый старт и настройка

### 1. Установка зависимостей
Требуется **Python 3.10+**:
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium   # Если запускаете с реальным браузером
```

### 2. Конфигурация `.env`
Скопируйте шаблон и укажите свои параметры:
```bash
cp .env.example .env
```
Основные настройки в `.env`:
- `TELEGRAM_BOT_TOKEN` — Токен бота от `@BotFather`.
- `TELEGRAM_ADMIN_IDS` — Ваш Telegram ID.
- `FUNPAY_GOLDEN_KEY` — Cookie `golden_key` из браузера на funpay.com.
- `OPENROUTER_API_KEY` — Бесплатный ключ от [openrouter.ai](https://openrouter.ai) (опционально, при отсутствии работает база знаний).
- `AUTOMATIC_CRYPTO_PAYMENT=true` — Включить полную авто-оплату в Base.
- `USE_MOCK_CRYPTO=true` / `USE_MOCK_BROWSER=true` — Безопасный режим тестирования без списаний и реального браузера.

---

## 🛠️ Команды CLI (`main.py`)

1. **Запуск полного демона** (FunPay Listener + Telegram Bot + Web Дашборд на порту 8000):
   ```bash
   python3 main.py run
   # Или в режиме симуляции:
   python3 main.py run --mock-browser --mock-funpay
   ```
   *После запуска откройте в браузере:* **`http://localhost:8000/`**

2. **Запуск только Web-дашборда и симулятора сделок**:
   ```bash
   python3 main.py web --web-port 8000
   ```

3. **Просмотр финансовой статистики и учета сделок в консоли**:
   ```bash
   python3 main.py stats
   ```

4. **Запуск тестового заказа с проверкой 2FA и авто-оплатой в Base**:
   ```bash
   python3 main.py test-order auto_base_user@gmail.com pass123 --2fa
   ```

5. **Запуск наборов тестов**:
   ```bash
   python3 test_pipeline.py    # Тесты автоматизации и парсеров
   python3 test_web_api.py     # Тесты Web-дашборда и AI API
   ```

---

## 🐳 Запуск через Docker (Linux VPS)

Для бесперебойной работы 24/7 на сервере:
```bash
docker-compose up -d --build
```
Просмотр логов контейнера:
```bash
docker-compose logs -f
```
Web-дашборд будет доступен по адресу вашего сервера: `http://ВAШ_IP:8000/`
