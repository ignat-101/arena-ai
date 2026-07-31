# 🚀 X.com Premium FunPay Automation v2.0 (Base Auto-Pay • OpenRouter AI • Web Dashboard)

Полнофункциональная автоматизированная система **X.com (Twitter) Premium** для продавцов на **FunPay** с **полностью автоматической ончейн-оплатой в сети Base Mainnet (EVM Chain ID: 8453)**, **интеллектуальным AI-ассистентом поддержки через OpenRouter API** и **Web-дашбордом на FastAPI** для мониторинга, симуляций и управления.

---

## ✨ Что нового в версии 2.0 (Full Auto & AI Engine)

1. **⚡ Реальный движок ончейн-оплаты в сети Base Mainnet (`src/crypto/base_payer.py`)**
   - Больше не нужно сканировать QR-код! Система автоматически формирует, подписывает и отправляет транзакции стандарта **EIP-1559** в сети **Base Mainnet** (`Chain ID: 8453`) через `web3.py`.
   - Включается параметром `AUTOMATIC_CRYPTO_PAYMENT=true` в `.env`.
   - При указании `SELLER_WALLET_PRIVATE_KEY="0x..."` и `USE_MOCK_CRYPTO=false` система проводит реальные транзакции ETH / USDC / USDT от кошелька продавца, проверяет баланс, оценивает газ (`w3.eth.estimate_gas`) и ожидает подтверждения блока в сети Base.
   - Поддерживает безопасный режим эмуляции ончейн-транзакций (`USE_MOCK_CRYPTO=true`) для тестирования и разработки без списания реальных средств.

2. **🤖 AI-Ассистент продавца в чате FunPay (`src/ai/support_agent.py`)**
   - Автоматически общается с покупателями в чатах FunPay: консультирует по срокам подписки, гарантиям, статусу выполнения заказа и техническим нюансам.
   - Подключается к бесплатным LLM через **OpenRouter API** (`google/gemini-2.0-flash-lite-preview-02-05:free` или `meta-llama/llama-3.3-70b-instruct:free`).
   - При отсутствии API-ключа автоматически включает интеллектуальную локальную базу знаний.
   - Ведет полный лог каждого диалога и сохраняет историю в базу данных.

3. **🌐 Web-Дашборд и интерактивный симулятор на FastAPI (`src/web/`)**
   - Красивый темный интерфейс на **Tailwind CSS**, доступный в браузере по адресу `http://localhost:8000/`.
   - **Карточки KPI и финансовая статистика**: общий оборот, количество ончейн-транзакций в Base и чистая прибыль (`+$3.50` в среднем с заказа).
   - **Симулятор заказа**: форма на сайте для мгновенного запуска теста авторизации X.com с возможностью эмуляции запроса 2FA и проверки авто-оплаты в Base.
   - **Интерактивный чат FunPay**: возможность выбрать любой заказ и вести диалог с AI-ассистентом прямо на сайте, а также отправлять 2FA-коды, если аккаунт требует проверку.

4. **📊 Учет сделок в SQLite и Telegram Bot v2.0 (`src/models/repository.py`, `src/telegram/bot.py`)**
   - База данных автоматически мигрировала и сохраняет: хэш транзакции (`tx_hash`), сумму в криптовалюте (`0.0035 ETH`), расчетную стоимость в USD и чистую прибыль, а также полный лог сообщений AI и покупателя.
   - Telegram-бот отправляет уведомление об успешной авто-оплате с ссылкой на хэш транзакции в Base:
     > **⚡ АВТО-ОПЛАТА ПОДПИСКИ В СЕТИ BASE**  
     > 🆔 Заказ: `#FP_33A...`  
     > 👤 Покупатель: `crypto_buyer` | 🔑 Аккаунт: `login@gmail.com`  
     > 🔗 **Tx Hash**: `0x3559543b4f...`  
     > 💰 Сумма: `0.0035 ETH (~$8.05)` | 💎 Прибыль: `$3.50`
   - Добавлены команды `/stats` (сводка по выручке и прибыли) и `/status` (список заказов).

---

## 🏗️ Структура проекта v2.0

```text
├── main.py                          # Главная CLI точка входа (run, web, stats, test-order)
├── check_prod.py                    # Диагностика подключения к Production (Base RPC, AI, FunPay)
├── test_pipeline.py                 # Автоматизированные тесты автоматизации (Unit & Integration)
├── test_web_api.py                  # Автоматизированные тесты Web-дашборда FastAPI
├── .env.example                     # Шаблон конфигурации v2.0
├── Dockerfile & docker-compose.yml  # Развертывание в Docker для Linux / VPS
├── requirements.txt                 # Зависимости Python
├── pyproject.toml                   # Спецификация пакета
└── src/
    ├── ai/                          # AI ассистент OpenRouter & локальная база знаний
    ├── crypto/                      # Движок автоматической оплаты в блокчейне Base (EVM web3.py)
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
- `SELLER_WALLET_PRIVATE_KEY=""` — Приватный ключ кошелька Base в формате `0x...` (для реальных транзакций в Base Mainnet).
- `USE_MOCK_CRYPTO=true` / `USE_MOCK_BROWSER=true` — Безопасный режим тестирования без списаний и реального браузера.

---

## 🛠️ Команды CLI (`main.py` & `check_prod.py`)

1. **Диагностика подключения к Production-сервисам** (Base Mainnet RPC, баланс кошелька, AI, Telegram, FunPay):
   ```bash
   python3 check_prod.py
   ```

2. **Запуск полного демона** (FunPay Listener + Telegram Bot + Web Дашборд на порту 8000):
   ```bash
   python3 main.py run
   # Или в режиме симуляции:
   python3 main.py run --mock-browser --mock-funpay
   ```
   *После запуска откройте в браузере:* **`http://localhost:8000/`**

3. **Запуск только Web-дашборда и симулятора сделок**:
   ```bash
   python3 main.py web --web-port 8000
   ```

4. **Просмотр финансовой статистики и учета сделок в консоли**:
   ```bash
   python3 main.py stats
   ```

5. **Запуск тестового заказа с проверкой 2FA и авто-оплатой в Base**:
   ```bash
   python3 main.py test-order auto_base_user@gmail.com pass123 --2fa
   ```

6. **Запуск наборов автоматизированных тестов**:
   ```bash
   python3 test_pipeline.py    # 7 тестов: парсеры, Base Payer, SQLite, AI и оркестратор
   python3 test_web_api.py     # 3 теста: REST API дашборда и симулятора чата
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
