"""
Генерация QR-кодов для оплаты через Trust Wallet / WalletConnect в сети Base.
"""

import io
from typing import Optional
import qrcode
from PIL import Image, ImageDraw, ImageFont


class QRGenerator:
    """Генератор QR-кодов в формате PNG для отправки в Telegram."""

    @staticmethod
    def generate_qr_image_bytes(
        data: str,
        title: Optional[str] = "BASE • TRUST WALLET",
        subtitle: Optional[str] = "Отсканируйте для оплаты подписки X Premium"
    ) -> bytes:
        """
        Генерирует PNG изображение QR-кода из строки (URI / ссылки / адреса оплаты)
        и возвращает байты изображения, готовые для отправки в Telegram.

        :param data: URI или данные для QR-кода (например, WalletConnect URI или Stripe Crypto URL)
        :param title: Заголовок над QR-кодом
        :param subtitle: Подзаголовок под QR-кодом
        :return: Байты изображения в формате PNG
        """
        # Создаем QR-код с хорошей четкостью и высокой коррекцией ошибок
        qr = qrcode.QRCode(
            version=1,
            error_correction=qrcode.constants.ERROR_CORRECT_H,
            box_size=10,
            border=4,
        )
        qr.add_data(data)
        qr.make(fit=True)

        # Генерируем базовое изображение QR-кода
        qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
        qr_width, qr_height = qr_img.size

        # Расширяем холст для добавления заголовков
        header_height = 60
        footer_height = 40
        canvas_width = max(qr_width, 420)
        canvas_height = qr_height + header_height + footer_height

        canvas = Image.new("RGB", (canvas_width, canvas_height), color=(255, 255, 255))

        # Вставляем QR-код по центру
        x_offset = (canvas_width - qr_width) // 2
        y_offset = header_height
        canvas.paste(qr_img, (x_offset, y_offset))

        draw = ImageDraw.Draw(canvas)

        # Пытаемся использовать стандартный шрифт, если нет - шрифт по умолчанию
        try:
            # На Linux обычно доступен DejaVuSans
            font_title = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 18)
            font_subtitle = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)
        except IOError:
            font_title = ImageFont.load_default()
            font_subtitle = ImageFont.load_default()

        # Рисуем заголовок сверху
        if title:
            bbox = draw.textbbox((0, 0), title, font=font_title)
            text_width = bbox[2] - bbox[0]
            tx = (canvas_width - text_width) // 2
            draw.text((tx, 20), title, fill=(0, 82, 255), font=font_title)  # Синий цвет Base (#0052FF)

        # Рисуем подзаголовок снизу
        if subtitle:
            bbox = draw.textbbox((0, 0), subtitle, font=font_subtitle)
            text_width = bbox[2] - bbox[0]
            tx = (canvas_width - text_width) // 2
            draw.text((tx, canvas_height - 30), subtitle, fill=(100, 100, 100), font=font_subtitle)

        # Сохраняем результат в байтовый буфер
        buffer = io.BytesIO()
        canvas.save(buffer, format="PNG", optimize=True)
        buffer.seek(0)
        return buffer.getvalue()


# Проверочный пример для локального теста
if __name__ == "__main__":
    test_uri = "wc:00e46b69-d0cc-4b3e-b6a2-cee442f97188@1?bridge=https%3A%2F%2Fbridge.walletconnect.org&key=41791102999c339c844880b23950704cc43aa840f3739e365323cda4dfa89e7a"
    img_bytes = QRGenerator.generate_qr_image_bytes(test_uri)
    print(f"QR код сгенерирован, размер: {len(img_bytes)} байт.")
