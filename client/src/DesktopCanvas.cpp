#include "DesktopCanvas.h"
#include <QPainter>
#include <QJsonObject>
#include <algorithm>

DesktopCanvas::DesktopCanvas(QQuickItem* parent)
    : QQuickPaintedItem(parent)
{
    setRenderTarget(QQuickPaintedItem::FramebufferObject);
    setPerformanceHint(QQuickPaintedItem::FastFBOResizing, true);
}

QRectF DesktopCanvas::targetRect() const
{
    if (m_framebuffer.isNull() || width() <= 1 || height() <= 1)
        return QRectF(0, 0, width(), height());

    const double srcW = m_framebuffer.width();
    const double srcH = m_framebuffer.height();
    const double dstW = width();
    const double dstH = height();

    const double scale = std::min(dstW / srcW, dstH / srcH);
    const double drawW = srcW * scale;
    const double drawH = srcH * scale;
    const double offsetX = (dstW - drawW) * 0.5;
    const double offsetY = (dstH - drawH) * 0.5;
    return QRectF(offsetX, offsetY, drawW, drawH);
}

void DesktopCanvas::paint(QPainter* painter)
{
    painter->fillRect(boundingRect(), QColor("#0B0D12"));
    if (m_framebuffer.isNull())
        return;

    painter->setRenderHint(QPainter::SmoothPixmapTransform, true);
    const QRectF dest = targetRect();
    painter->drawImage(dest, m_framebuffer, QRectF(0, 0, m_framebuffer.width(), m_framebuffer.height()));
}

void DesktopCanvas::applyDeltaFrame(int screenW, int screenH, bool fullFrame, const QJsonArray& tiles, const QByteArray& payload, int cursorX, int cursorY)
{
    if (screenW <= 0 || screenH <= 0)
        return;

    bool resized = false;
    if (m_framebuffer.isNull() || m_framebuffer.width() != screenW || m_framebuffer.height() != screenH)
    {
        m_framebuffer = QImage(screenW, screenH, QImage::Format_RGB32);
        m_framebuffer.fill(QColor("#101218"));
        resized = true;
    }
    else if (fullFrame)
    {
        m_framebuffer.fill(QColor("#101218"));
    }

    QPainter p(&m_framebuffer);
    p.setCompositionMode(QPainter::CompositionMode_Source);

    QRect dirtyBounds;
    for (const QJsonValue& val : tiles)
    {
        const QJsonObject tileObj = val.toObject();
        const int x = tileObj.value("x").toInt();
        const int y = tileObj.value("y").toInt();
        const int offset = tileObj.value("offset").toInt();
        const int length = tileObj.value("length").toInt();

        if (offset < 0 || length <= 0 || offset + length > payload.size())
            continue;

        const uchar* bytes = reinterpret_cast<const uchar*>(payload.constData() + offset);
        QImage tileImg = QImage::fromData(bytes, length);
        if (!tileImg.isNull())
        {
            p.drawImage(x, y, tileImg);
            dirtyBounds = dirtyBounds.united(QRect(x, y, tileImg.width(), tileImg.height()));
        }
    }
    p.end();

    m_remoteCursorX = cursorX;
    m_remoteCursorY = cursorY;

    if (resized)
        emit dimensionsChanged();
    emit frameUpdated();

    if (resized || fullFrame || dirtyBounds.isEmpty() || m_framebuffer.width() <= 0 || m_framebuffer.height() <= 0)
    {
        update();
    }
    else
    {
        const QRectF dest = targetRect();
        const double scaleX = dest.width() / m_framebuffer.width();
        const double scaleY = dest.height() / m_framebuffer.height();
        const QRect itemDirty(
            static_cast<int>(dest.left() + dirtyBounds.left() * scaleX) - 2,
            static_cast<int>(dest.top() + dirtyBounds.top() * scaleY) - 2,
            static_cast<int>(dirtyBounds.width() * scaleX) + 4,
            static_cast<int>(dirtyBounds.height() * scaleY) + 4);
        update(itemDirty.intersected(boundingRect().toRect()));
    }
}

void DesktopCanvas::clearCanvas()
{
    m_framebuffer = QImage();
    emit dimensionsChanged();
    emit frameUpdated();
    update();
}

QVariantMap DesktopCanvas::mapToNormalized(double itemX, double itemY) const
{
    QVariantMap result;
    const QRectF rect = targetRect();
    if (rect.width() <= 1 || rect.height() <= 1)
    {
        result["x"] = 0.5;
        result["y"] = 0.5;
        result["inside"] = false;
        return result;
    }

    const double relX = (itemX - rect.left()) / rect.width();
    const double relY = (itemY - rect.top()) / rect.height();
    result["x"] = std::clamp(relX, 0.0, 1.0);
    result["y"] = std::clamp(relY, 0.0, 1.0);
    result["inside"] = (relX >= 0.0 && relX <= 1.0 && relY >= 0.0 && relY <= 1.0);
    return result;
}
