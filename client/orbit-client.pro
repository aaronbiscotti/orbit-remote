QT += core gui network qml quick quickcontrols2
CONFIG += c++17 release

TARGET = Orbit
TEMPLATE = app

SOURCES += \
    src/main.cpp \
    src/DesktopCanvas.cpp \
    src/OrbitBackend.cpp

HEADERS += \
    src/DesktopCanvas.h \
    src/OrbitBackend.h

RESOURCES += \
    resources.qrc

macx {
    QMAKE_INFO_PLIST = Info.plist
    CONFIG += app_bundle
}
