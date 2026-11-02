#pragma once

#include <QObject>
#include <QSslSocket>
#include <QVariantList>
#include <QVariantMap>
#include <QTimer>
#include <QByteArray>
#include <QJsonDocument>
#include <QJsonObject>
#include "DesktopCanvas.h"

class OrbitBackend : public QObject
{
    Q_OBJECT
    Q_PROPERTY(QVariantList computers READ computers NOTIFY computersChanged)
    Q_PROPERTY(bool pairing READ pairing NOTIFY pairingChanged)
    Q_PROPERTY(QString pairingPin READ pairingPin NOTIFY pairingChanged)
    Q_PROPERTY(QString pairingHost READ pairingHost NOTIFY pairingChanged)
    Q_PROPERTY(bool connected READ connected NOTIFY sessionStateChanged)
    Q_PROPERTY(bool connecting READ connecting NOTIFY sessionStateChanged)
    Q_PROPERTY(QString activeHostName READ activeHostName NOTIFY sessionStateChanged)
    Q_PROPERTY(QString activePrivilege READ activePrivilege NOTIFY sessionStateChanged)
    Q_PROPERTY(QString activeDesktop READ activeDesktop NOTIFY sessionStateChanged)
    Q_PROPERTY(bool secureDesktopActive READ secureDesktopActive NOTIFY sessionStateChanged)
    Q_PROPERTY(bool privacyCurtain READ privacyCurtain NOTIFY sessionStateChanged)
    Q_PROPERTY(QString qualityMode READ qualityMode NOTIFY qualityModeChanged)
    Q_PROPERTY(int selectedMonitor READ selectedMonitor NOTIFY sessionStateChanged)
    Q_PROPERTY(QVariantList monitors READ monitors NOTIFY sessionStateChanged)
    Q_PROPERTY(QString bandwidthText READ bandwidthText NOTIFY statsChanged)
    Q_PROPERTY(int lastTileCount READ lastTileCount NOTIFY statsChanged)
    Q_PROPERTY(QString statusMessage READ statusMessage NOTIFY statusMessageChanged)
    Q_PROPERTY(QString terminalOutput READ terminalOutput NOTIFY terminalChanged)
    Q_PROPERTY(QString terminalCwd READ terminalCwd NOTIFY terminalChanged)
    Q_PROPERTY(bool terminalBusy READ terminalBusy NOTIFY terminalChanged)
    Q_PROPERTY(QString currentFsPath READ currentFsPath NOTIFY filesChanged)
    Q_PROPERTY(QString parentFsPath READ parentFsPath NOTIFY filesChanged)
    Q_PROPERTY(QVariantList fileEntries READ fileEntries NOTIFY filesChanged)
    Q_PROPERTY(QVariantList processEntries READ processEntries NOTIFY processesChanged)
    Q_PROPERTY(bool mapCommandToCtrl READ mapCommandToCtrl WRITE setMapCommandToCtrl NOTIFY settingsChanged)

public:
    explicit OrbitBackend(QObject* parent = nullptr);
    ~OrbitBackend() override;

    QVariantList computers() const { return m_computers; }
    bool pairing() const { return m_pairing; }
    QString pairingPin() const { return m_pairingPin; }
    QString pairingHost() const { return m_pairingHost; }
    bool connected() const { return m_connected; }
    bool connecting() const { return m_connecting; }
    QString activeHostName() const { return m_activeHostName; }
    QString activePrivilege() const { return m_activePrivilege; }
    QString activeDesktop() const { return m_activeDesktop; }
    bool secureDesktopActive() const { return m_secureDesktopActive; }
    bool privacyCurtain() const { return m_privacyCurtain; }
    QString qualityMode() const { return m_qualityMode; }
    int selectedMonitor() const { return m_selectedMonitor; }
    QVariantList monitors() const { return m_monitors; }
    QString bandwidthText() const { return m_bandwidthText; }
    int lastTileCount() const { return m_lastTileCount; }
    QString statusMessage() const { return m_statusMessage; }
    QString terminalOutput() const { return m_terminalOutput; }
    QString terminalCwd() const { return m_terminalCwd; }
    bool terminalBusy() const { return m_terminalBusy; }
    QString currentFsPath() const { return m_currentFsPath; }
    QString parentFsPath() const { return m_parentFsPath; }
    QVariantList fileEntries() const { return m_fileEntries; }
    QVariantList processEntries() const { return m_processEntries; }
    bool mapCommandToCtrl() const { return m_mapCommandToCtrl; }
    void setMapCommandToCtrl(bool enabled);

    Q_INVOKABLE void registerCanvas(DesktopCanvas* canvas);
    Q_INVOKABLE void addComputer(const QString& addressInput);
    Q_INVOKABLE void removeComputer(const QString& address);
    Q_INVOKABLE void refreshComputers();
    Q_INVOKABLE void activateComputer(const QString& address);
    Q_INVOKABLE void cancelPairing();
    Q_INVOKABLE void disconnectSession();

    // Desktop Takeover Input & Display
    Q_INVOKABLE void sendMouse(const QString& action, double normX, double normY, const QString& button, int deltaX = 0, int deltaY = 0);
    Q_INVOKABLE void sendKeyEvent(const QString& action, int qtKey, int modifiers, const QString& text);
    Q_INVOKABLE void sendText(const QString& text);
    Q_INVOKABLE void sendCtrlAltDel();
    Q_INVOKABLE void setQualityPreset(const QString& quality);
    Q_INVOKABLE void selectMonitor(int monitorIndex);
    Q_INVOKABLE void matchClientResolution(int width, int height);
    Q_INVOKABLE void restoreHostResolution();
    Q_INVOKABLE void togglePrivacyCurtain();
    Q_INVOKABLE void syncClipboardToPc();
    Q_INVOKABLE void pullClipboardFromPc();

    // Native OS Takeover Tools (Terminal, Files, Processes, Power)
    Q_INVOKABLE void runCommand(const QString& command, const QString& shell = "powershell");
    Q_INVOKABLE void clearTerminal();
    Q_INVOKABLE void browsePath(const QString& path);
    Q_INVOKABLE void downloadFile(const QString& remotePath);
    Q_INVOKABLE void uploadSampleNote(const QString& fileName, const QString& content);
    Q_INVOKABLE void uploadLocalFile(const QString& localPath);
    Q_INVOKABLE void deleteRemotePath(const QString& remotePath);
    Q_INVOKABLE void refreshProcesses();
    Q_INVOKABLE void killProcess(int pid);
    Q_INVOKABLE void sendPowerAction(const QString& action);

signals:
    void computersChanged();
    void pairingChanged();
    void sessionStateChanged();
    void qualityModeChanged();
    void statsChanged();
    void statusMessageChanged();
    void terminalChanged();
    void filesChanged();
    void processesChanged();
    void settingsChanged();

private:
    void loadSettings();
    void saveSettings();
    void setStatus(const QString& msg);
    void probeComputer(int index);
    void startPairing(const QString& address, int port);
    void startSession(const QString& address, int port, const QString& expectedCertSha256);

    static void parseEndpoint(const QString& raw, QString& outHost, int& outPort);
    static void writeFrame(QSslSocket* socket, const QJsonObject& json, const QByteArray& binary = QByteArray());
    static bool tryExtractFrame(QByteArray& buffer, QJsonObject& outJson, QByteArray& outBinary);
    static QString computePairingCommitment(const QString& pin, const QString& certSha256Hex, const QString& clientId, const QString& tokenHashHex);
    static QString computeAuthProof(const QString& tokenHashHex, const QString& serverNonce, const QString& certSha256Hex);
    static int qtKeyToWindowsVk(int qtKey, const QString& text);

    void handleSessionFrame(const QJsonObject& json, const QByteArray& binary);

    DesktopCanvas* m_canvas = nullptr;
    QString m_clientId;
    QString m_clientName;
    QString m_tokenHashHex;
    QVariantList m_computers;

    // Pairing state
    bool m_pairing = false;
    QString m_pairingPin;
    QString m_pairingHost;
    QSslSocket* m_pairSocket = nullptr;
    QByteArray m_pairReadBuffer;

    // Session state
    QSslSocket* m_sessionSocket = nullptr;
    QByteArray m_sessionReadBuffer;
    bool m_connected = false;
    bool m_connecting = false;
    QString m_activeAddress;
    QString m_activeHostName;
    QString m_activePrivilege = "Standard";
    QString m_activeDesktop = "Default";
    bool m_secureDesktopActive = false;
    bool m_privacyCurtain = false;
    QString m_qualityMode = "crisp";
    int m_selectedMonitor = 0;
    QVariantList m_monitors;

    // Bandwidth & Dirty-Tile Telemetry
    QTimer m_statsTimer;
    QTimer m_probeTimer;
    qint64 m_bytesThisSecond = 0;
    int m_tilesThisSecond = 0;
    int m_lastTileCount = 0;
    QString m_bandwidthText = "0.0 KB/s · Idle";
    QString m_statusMessage;

    // Native OS Takeover Panels
    QString m_terminalOutput;
    QString m_terminalCwd = "C:\\";
    bool m_terminalBusy = false;
    int m_cmdCounter = 0;

    QString m_currentFsPath;
    QString m_parentFsPath;
    QVariantList m_fileEntries;
    QVariantList m_processEntries;
    bool m_mapCommandToCtrl = true;
};
