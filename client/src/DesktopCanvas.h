#pragma once

#include <QQuickPaintedItem>
#include <QImage>
#include <QJsonArray>
#include <QByteArray>
#include <QVariantMap>

class DesktopCanvas : public QQuickPaintedItem
{
    Q_OBJECT
    Q_PROPERTY(int remoteWidth READ remoteWidth NOTIFY dimensionsChanged)
    Q_PROPERTY(int remoteHeight READ remoteHeight NOTIFY dimensionsChanged)
    Q_PROPERTY(bool hasFrame READ hasFrame NOTIFY frameUpdated)

public:
    explicit DesktopCanvas(QQuickItem* parent = nullptr);

    void paint(QPainter* painter) override;

    int remoteWidth() const { return m_framebuffer.width(); }
    int remoteHeight() const { return m_framebuffer.height(); }
    bool hasFrame() const { return !m_framebuffer.isNull(); }

    void applyDeltaFrame(int screenW, int screenH, bool fullFrame, const QJsonArray& tiles, const QByteArray& payload, int cursorX, int cursorY);
    Q_INVOKABLE void clearCanvas();
    Q_INVOKABLE QVariantMap mapToNormalized(double itemX, double itemY) const;

signals:
    void dimensionsChanged();
    void frameUpdated();

private:
    QRectF targetRect() const;

    QImage m_framebuffer;
    int m_remoteCursorX = 0;
    int m_remoteCursorY = 0;
};
