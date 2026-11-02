#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickStyle>
#include "DesktopCanvas.h"
#include "OrbitBackend.h"

int main(int argc, char *argv[])
{
    QGuiApplication app(argc, argv);
    QCoreApplication::setOrganizationName("Orbit Remote");
    QCoreApplication::setOrganizationDomain("orbit.local");
    QCoreApplication::setApplicationName("Orbit");

    QQuickStyle::setStyle("Basic");

    qmlRegisterType<DesktopCanvas>("Orbit", 1, 0, "DesktopCanvas");

    OrbitBackend backend;
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("Orbit", &backend);

    const QUrl url(QStringLiteral("qrc:/qml/main.qml"));
    QObject::connect(&engine, &QQmlApplicationEngine::objectCreated,
        &app, [url](QObject *obj, const QUrl &objUrl) {
            if (!obj && url == objUrl)
                QCoreApplication::exit(-1);
        }, Qt::QueuedConnection);

    engine.load(url);
    return app.exec();
}
