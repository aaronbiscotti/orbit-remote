#include "OrbitBackend.h"
#include <QSettings>
#include <QUuid>
#include <QHostInfo>
#include <QCryptographicHash>
#include <QMessageAuthenticationCode>
#include <QRandomGenerator>
#include <QJsonArray>
#include <QGuiApplication>
#include <QClipboard>
#include <QStandardPaths>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QUrl>
#include <QSslConfiguration>
#include <QSslCertificate>
#include <QtEndian>

OrbitBackend::OrbitBackend(QObject* parent)
    : QObject(parent)
{
    loadSettings();

    connect(&m_statsTimer, &QTimer::timeout, this, [this]() {
        if (!m_connected)
        {
            m_bandwidthText = "Disconnected";
        }
        else if (m_bytesThisSecond == 0)
        {
            m_bandwidthText = "0.0 KB/s · Static (0 tiles sent)";
            m_lastTileCount = 0;
        }
        else
        {
            const double kbps = m_bytesThisSecond / 1024.0;
            m_bandwidthText = QString("%1 KB/s · %2 dirty %3")
                .arg(kbps, 0, 'f', 1)
                .arg(m_tilesThisSecond)
                .arg(m_tilesThisSecond == 1 ? "tile" : "tiles");
            m_lastTileCount = m_tilesThisSecond;
        }
        m_bytesThisSecond = 0;
        m_tilesThisSecond = 0;
        emit statsChanged();
    });
    m_statsTimer.start(1000);

    connect(&m_probeTimer, &QTimer::timeout, this, [this]() {
        if (!m_connected && !m_connecting && !m_pairing)
            refreshComputers();
    });
    m_probeTimer.start(5000);

    QTimer::singleShot(250, this, &OrbitBackend::refreshComputers);
}

OrbitBackend::~OrbitBackend()
{
    cancelPairing();
    disconnectSession();
}

void OrbitBackend::loadSettings()
{
    QSettings settings("Orbit Remote", "Orbit");
    m_clientId = settings.value("client/id").toString();
    if (m_clientId.isEmpty())
    {
        m_clientId = QUuid::createUuid().toString(QUuid::WithoutBraces);
        settings.setValue("client/id", m_clientId);
    }

    m_clientName = QHostInfo::localHostName();
    if (m_clientName.isEmpty())
        m_clientName = "Mac";

    QString secretHex = settings.value("client/secretHex").toString();
    if (secretHex.length() != 64)
    {
        QByteArray randomBytes(32, 0);
        for (int i = 0; i < 32; ++i)
            randomBytes[i] = static_cast<char>(QRandomGenerator::system()->bounded(256));
        secretHex = QString::fromLatin1(randomBytes.toHex()).toLower();
        settings.setValue("client/secretHex", secretHex);
    }

    const QByteArray tokenHash = QCryptographicHash::hash(QByteArray::fromHex(secretHex.toLatin1()), QCryptographicHash::Sha256);
    m_tokenHashHex = QString::fromLatin1(tokenHash.toHex()).toLower();

    m_qualityMode = settings.value("client/qualityMode", "crisp").toString();
    m_mapCommandToCtrl = settings.value("client/mapCommandToCtrl", true).toBool();

    m_computers.clear();
    const int count = settings.beginReadArray("computers");
    for (int i = 0; i < count; ++i)
    {
        settings.setArrayIndex(i);
        QVariantMap pc;
        pc["address"] = settings.value("address").toString();
        pc["name"] = settings.value("name", pc["address"]).toString();
        pc["certSha256"] = settings.value("certSha256").toString();
        pc["paired"] = settings.value("paired", false).toBool();
        pc["online"] = false;
        pc["statusUnknown"] = true;
        pc["privilege"] = settings.value("privilege", "Standard").toString();
        pc["desktop"] = "Default";
        if (!pc["address"].toString().isEmpty())
            m_computers.append(pc);
    }
    settings.endArray();
    emit computersChanged();
}

void OrbitBackend::saveSettings()
{
    QSettings settings("Orbit Remote", "Orbit");
    settings.setValue("client/qualityMode", m_qualityMode);
    settings.setValue("client/mapCommandToCtrl", m_mapCommandToCtrl);
    settings.beginWriteArray("computers", m_computers.size());
    for (int i = 0; i < m_computers.size(); ++i)
    {
        settings.setArrayIndex(i);
        const QVariantMap pc = m_computers[i].toMap();
        settings.setValue("address", pc.value("address").toString());
        settings.setValue("name", pc.value("name").toString());
        settings.setValue("certSha256", pc.value("certSha256").toString());
        settings.setValue("paired", pc.value("paired").toBool());
        settings.setValue("privilege", pc.value("privilege").toString());
    }
    settings.endArray();
}

void OrbitBackend::setMapCommandToCtrl(bool enabled)
{
    if (m_mapCommandToCtrl == enabled) return;
    m_mapCommandToCtrl = enabled;
    saveSettings();
    emit settingsChanged();
}

void OrbitBackend::setStatus(const QString& msg)
{
    if (m_statusMessage == msg) return;
    m_statusMessage = msg;
    emit statusMessageChanged();
}

void OrbitBackend::registerCanvas(DesktopCanvas* canvas)
{
    m_canvas = canvas;
}

void OrbitBackend::parseEndpoint(const QString& raw, QString& outHost, int& outPort)
{
    QString trimmed = raw.trimmed();
    outPort = 47995;
    outHost = trimmed;
    const int colon = trimmed.lastIndexOf(':');
    if (colon > 0 && !trimmed.contains(']'))
    {
        bool ok = false;
        const int port = trimmed.mid(colon + 1).toInt(&ok);
        if (ok && port > 0 && port < 65536)
        {
            outHost = trimmed.left(colon);
            outPort = port;
        }
    }
}

void OrbitBackend::addComputer(const QString& addressInput)
{
    QString host;
    int port = 47995;
    parseEndpoint(addressInput, host, port);
    if (host.isEmpty()) return;

    const QString canonical = (port == 47995) ? host : QString("%1:%2").arg(host).arg(port);
    for (int i = 0; i < m_computers.size(); ++i)
    {
        if (m_computers[i].toMap().value("address").toString().compare(canonical, Qt::CaseInsensitive) == 0)
        {
            probeComputer(i);
            return;
        }
    }

    QVariantMap pc;
    pc["address"] = canonical;
    pc["name"] = host;
    pc["certSha256"] = "";
    pc["paired"] = false;
    pc["online"] = false;
    pc["statusUnknown"] = true;
    pc["privilege"] = "Standard";
    pc["desktop"] = "Default";
    m_computers.append(pc);
    saveSettings();
    emit computersChanged();
    probeComputer(m_computers.size() - 1);
}

void OrbitBackend::removeComputer(const QString& address)
{
    for (int i = 0; i < m_computers.size(); ++i)
    {
        if (m_computers[i].toMap().value("address").toString().compare(address, Qt::CaseInsensitive) == 0)
        {
            m_computers.removeAt(i);
            saveSettings();
            emit computersChanged();
            return;
        }
    }
}

void OrbitBackend::refreshComputers()
{
    for (int i = 0; i < m_computers.size(); ++i)
        probeComputer(i);
}

void OrbitBackend::probeComputer(int index)
{
    if (index < 0 || index >= m_computers.size()) return;
    const QVariantMap current = m_computers[index].toMap();
    const QString address = current.value("address").toString();
    QString host;
    int port = 47995;
    parseEndpoint(address, host, port);

    auto* socket = new QSslSocket(this);
    auto buffer = std::make_shared<QByteArray>();

    QObject::connect(socket, &QSslSocket::sslErrors, socket, [socket]() {
        socket->ignoreSslErrors();
    });

    QObject::connect(socket, &QSslSocket::encrypted, this, [this, socket]() {
        QJsonObject probe;
        probe["type"] = "probe";
        probe["clientId"] = m_clientId;
        probe["clientName"] = m_clientName;
        writeFrame(socket, probe);
    });

    QObject::connect(socket, &QSslSocket::readyRead, this, [this, socket, buffer, address]() {
        buffer->append(socket->readAll());
        QJsonObject json;
        QByteArray bin;
        while (tryExtractFrame(*buffer, json, bin))
        {
            const QString type = json.value("type").toString();
            if (type == "probe_result")
            {
                for (int i = 0; i < m_computers.size(); ++i)
                {
                    QVariantMap pc = m_computers[i].toMap();
                    if (pc.value("address").toString().compare(address, Qt::CaseInsensitive) == 0)
                    {
                        pc["online"] = true;
                        pc["statusUnknown"] = false;
                        pc["name"] = json.value("hostname").toString(pc["name"].toString());
                        pc["paired"] = json.value("paired").toBool();
                        pc["privilege"] = json.value("privilege").toString("Standard");
                        pc["desktop"] = json.value("desktop").toString("Default");
                        if (pc["paired"].toBool() && pc["certSha256"].toString().isEmpty())
                            pc["certSha256"] = json.value("certSha256").toString();
                        m_computers[i] = pc;
                        saveSettings();
                        emit computersChanged();
                        break;
                    }
                }
                socket->disconnectFromHost();
            }
        }
    });

    QObject::connect(socket, &QAbstractSocket::errorOccurred, this, [this, socket, address](QAbstractSocket::SocketError) {
        for (int i = 0; i < m_computers.size(); ++i)
        {
            QVariantMap pc = m_computers[i].toMap();
            if (pc.value("address").toString().compare(address, Qt::CaseInsensitive) == 0)
            {
                pc["online"] = false;
                pc["statusUnknown"] = false;
                m_computers[i] = pc;
                emit computersChanged();
                break;
            }
        }
        socket->deleteLater();
    });

    QObject::connect(socket, &QSslSocket::disconnected, socket, &QObject::deleteLater);

    QTimer::singleShot(3500, socket, [socket]() {
        if (socket->state() != QAbstractSocket::UnconnectedState)
            socket->abort();
    });

    socket->connectToHostEncrypted(host, static_cast<quint16>(port));
}

void OrbitBackend::activateComputer(const QString& address)
{
    for (int i = 0; i < m_computers.size(); ++i)
    {
        const QVariantMap pc = m_computers[i].toMap();
        if (pc.value("address").toString().compare(address, Qt::CaseInsensitive) == 0)
        {
            QString host;
            int port = 47995;
            parseEndpoint(address, host, port);

            if (pc.value("paired").toBool())
            {
                m_activeAddress = address;
                m_activeHostName = pc.value("name").toString();
                startSession(host, port, pc.value("certSha256").toString());
            }
            else
            {
                m_pairingHost = pc.value("name").toString();
                startPairing(host, port);
            }
            return;
        }
    }
}

void OrbitBackend::startPairing(const QString& host, int port)
{
    cancelPairing();

    const int pinVal = QRandomGenerator::system()->bounded(1000, 10000);
    m_pairingPin = QString::number(pinVal);
    m_pairing = true;
    emit pairingChanged();

    m_pairSocket = new QSslSocket(this);
    m_pairReadBuffer.clear();

    connect(m_pairSocket, &QSslSocket::sslErrors, m_pairSocket, [this]() {
        if (m_pairSocket) m_pairSocket->ignoreSslErrors();
    });

    connect(m_pairSocket, &QSslSocket::readyRead, this, [this, host, port]() {
        if (!m_pairSocket) return;
        m_pairReadBuffer.append(m_pairSocket->readAll());

        QJsonObject json;
        QByteArray bin;
        while (tryExtractFrame(m_pairReadBuffer, json, bin))
        {
            const QString type = json.value("type").toString();
            if (type == "hello")
            {
                const QString certSha256 = json.value("certSha256").toString().toLower();
                const QString commitment = computePairingCommitment(m_pairingPin, certSha256, m_clientId, m_tokenHashHex);
                QJsonObject req;
                req["type"] = "pair_request";
                req["clientId"] = m_clientId;
                req["clientName"] = m_clientName;
                req["tokenHash"] = m_tokenHashHex;
                req["commitment"] = commitment;
                writeFrame(m_pairSocket, req);
            }
            else if (type == "pair_status")
            {
                const bool ok = json.value("paired").toBool();
                const QString certSha256 = json.value("certSha256").toString().toLower();
                const QString hostname = json.value("hostname").toString(host);
                const QString canonical = (port == 47995) ? host : QString("%1:%2").arg(host).arg(port);

                if (ok)
                {
                    for (int i = 0; i < m_computers.size(); ++i)
                    {
                        QVariantMap pc = m_computers[i].toMap();
                        if (pc.value("address").toString().compare(canonical, Qt::CaseInsensitive) == 0)
                        {
                            pc["paired"] = true;
                            pc["online"] = true;
                            pc["statusUnknown"] = false;
                            pc["name"] = hostname;
                            pc["certSha256"] = certSha256;
                            m_computers[i] = pc;
                            saveSettings();
                            emit computersChanged();
                            break;
                        }
                    }
                    setStatus("Paired with " + hostname + ". Click Connect to take over your PC.");
                }
                else
                {
                    setStatus(json.value("error").toString("Pairing was not approved."));
                }
                cancelPairing();
            }
        }
    });

    connect(m_pairSocket, &QAbstractSocket::errorOccurred, this, [this](QAbstractSocket::SocketError) {
        if (m_pairing)
        {
            setStatus("Could not reach Orbit Host for pairing.");
            cancelPairing();
        }
    });

    m_pairSocket->connectToHostEncrypted(host, static_cast<quint16>(port));
}

void OrbitBackend::cancelPairing()
{
    if (m_pairSocket)
    {
        m_pairSocket->disconnect(this);
        m_pairSocket->abort();
        m_pairSocket->deleteLater();
        m_pairSocket = nullptr;
    }
    m_pairReadBuffer.clear();
    if (m_pairing)
    {
        m_pairing = false;
        emit pairingChanged();
    }
}

void OrbitBackend::startSession(const QString& host, int port, const QString& expectedCertSha256)
{
    disconnectSession();

    m_connecting = true;
    setStatus("Connecting to " + m_activeHostName + "…");
    emit sessionStateChanged();

    m_sessionSocket = new QSslSocket(this);
    m_sessionSocket->setSocketOption(QAbstractSocket::LowDelayOption, 1);
    m_sessionSocket->setSocketOption(QAbstractSocket::KeepAliveOption, 1);
    m_sessionReadBuffer.clear();

    connect(m_sessionSocket, &QSslSocket::sslErrors, m_sessionSocket, [this]() {
        if (m_sessionSocket) m_sessionSocket->ignoreSslErrors();
    });

    connect(m_sessionSocket, &QSslSocket::readyRead, this, [this, expectedCertSha256]() {
        if (!m_sessionSocket) return;
        m_sessionReadBuffer.append(m_sessionSocket->readAll());

        QJsonObject json;
        QByteArray bin;
        while (tryExtractFrame(m_sessionReadBuffer, json, bin))
        {
            const QString type = json.value("type").toString();
            if (type == "hello")
            {
                const QSslCertificate peerCert = m_sessionSocket->peerCertificate();
                const QString actualDigest = QString::fromLatin1(peerCert.digest(QCryptographicHash::Sha256).toHex()).toLower();
                const QString serverReportedDigest = json.value("certSha256").toString().toLower();

                if (!expectedCertSha256.isEmpty() && !actualDigest.isEmpty() &&
                    expectedCertSha256.compare(actualDigest, Qt::CaseInsensitive) != 0)
                {
                    setStatus("Host TLS certificate changed or did not match pinned identity. Remove and re-pair this PC.");
                    disconnectSession();
                    return;
                }

                const QString certDigest = !actualDigest.isEmpty() ? actualDigest : serverReportedDigest;
                const QString nonce = json.value("nonce").toString();
                const QString proof = computeAuthProof(m_tokenHashHex, nonce, certDigest);

                QJsonObject auth;
                auth["type"] = "auth";
                auth["clientId"] = m_clientId;
                auth["clientName"] = m_clientName;
                auth["proof"] = proof;
                auth["quality"] = m_qualityMode;
                auth["monitor"] = m_selectedMonitor;
                writeFrame(m_sessionSocket, auth);
                continue;
            }

            handleSessionFrame(json, bin);
        }
    });

    connect(m_sessionSocket, &QAbstractSocket::errorOccurred, this, [this](QAbstractSocket::SocketError) {
        if (m_connected || m_connecting)
        {
            setStatus("Disconnected from PC.");
            disconnectSession();
        }
    });

    connect(m_sessionSocket, &QSslSocket::disconnected, this, [this]() {
        if (m_connected || m_connecting)
            disconnectSession();
    });

    m_sessionSocket->connectToHostEncrypted(host, static_cast<quint16>(port));
}

void OrbitBackend::handleSessionFrame(const QJsonObject& json, const QByteArray& binary)
{
    const QString type = json.value("type").toString();

    if (type == "auth_error")
    {
        setStatus(json.value("error").toString("Authentication failed."));
        disconnectSession();
        return;
    }

    if (type == "auth_ok")
    {
        m_connecting = false;
        m_connected = true;
        m_activeHostName = json.value("hostname").toString(m_activeHostName);
        m_activePrivilege = json.value("privilege").toString("Standard");
        m_activeDesktop = json.value("desktop").toString("Default");
        m_secureDesktopActive = json.value("secureDesktop").toBool();
        m_privacyCurtain = json.value("privacyCurtain").toBool();
        m_monitors = json.value("monitors").toArray().toVariantList();
        setStatus("");
        emit sessionStateChanged();

        browsePath("drives");
        refreshProcesses();
        return;
    }

    if (type == "frame")
    {
        const qint64 seq = json.value("seq").toVariant().toLongLong();
        const int screenW = json.value("screenW").toInt();
        const int screenH = json.value("screenH").toInt();
        const bool full = json.value("full").toBool();
        const int cursorX = json.value("cursorX").toInt();
        const int cursorY = json.value("cursorY").toInt();
        const QJsonArray tiles = json.value("tiles").toArray();

        const QString newPriv = json.value("privilege").toString(m_activePrivilege);
        const QString newDesk = json.value("desktop").toString(m_activeDesktop);
        const bool newSec = json.value("secureDesktop").toBool();

        if (newPriv != m_activePrivilege || newDesk != m_activeDesktop || newSec != m_secureDesktopActive)
        {
            m_activePrivilege = newPriv;
            m_activeDesktop = newDesk;
            m_secureDesktopActive = newSec;
            emit sessionStateChanged();
        }

        m_bytesThisSecond += binary.size();
        m_tilesThisSecond += tiles.size();

        if (m_canvas)
        {
            m_canvas->applyDeltaFrame(screenW, screenH, full, tiles, binary, cursorX, cursorY);
        }

        if (m_sessionSocket)
        {
            QJsonObject ack;
            ack["type"] = "frame_ack";
            ack["seq"] = seq;
            writeFrame(m_sessionSocket, ack);
        }
        return;
    }

    if (type == "privacy_curtain_result")
    {
        m_privacyCurtain = json.value("enabled").toBool();
        emit sessionStateChanged();
        return;
    }

    if (type == "clipboard_data")
    {
        const QString text = json.value("text").toString();
        if (!text.isEmpty() && QGuiApplication::clipboard())
        {
            QGuiApplication::clipboard()->setText(text);
            setStatus("Copied PC clipboard to Mac.");
        }
        return;
    }

    if (type == "exec_result")
    {
        m_terminalBusy = false;
        const QString stdoutText = json.value("stdout").toString();
        const QString stderrText = json.value("stderr").toString();
        const int exitCode = json.value("exitCode").toInt();
        m_terminalCwd = json.value("cwd").toString(m_terminalCwd);

        if (!stdoutText.isEmpty())
            m_terminalOutput += stdoutText + "\n";
        if (!stderrText.isEmpty())
            m_terminalOutput += "[stderr] " + stderrText + "\n";
        if (stdoutText.isEmpty() && stderrText.isEmpty())
            m_terminalOutput += QString("(completed with exit code %1)\n").arg(exitCode);

        emit terminalChanged();
        return;
    }

    if (type == "fs_list_result")
    {
        m_currentFsPath = json.value("path").toString();
        m_parentFsPath = json.value("parent").toString();
        m_fileEntries = json.value("entries").toArray().toVariantList();
        const QString err = json.value("error").toString();
        if (!err.isEmpty()) setStatus(err);
        emit filesChanged();
        return;
    }

    if (type == "fs_download_result")
    {
        if (json.value("ok").toBool())
        {
            const QString fileName = json.value("name").toString("downloaded-file");
            const QString downloadsDir = QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
            const QString targetPath = QDir(downloadsDir).filePath(fileName);
            QFile out(targetPath);
            if (out.open(QIODevice::WriteOnly))
            {
                out.write(binary);
                out.close();
                setStatus("Downloaded to " + targetPath);
            }
        }
        else
        {
            setStatus(json.value("error").toString("Download failed."));
        }
        return;
    }

    if (type == "fs_upload_result" || type == "fs_delete_result")
    {
        if (json.value("ok").toBool())
            browsePath(m_currentFsPath.isEmpty() ? "drives" : m_currentFsPath);
        else
            setStatus(json.value("error").toString("File operation failed."));
        return;
    }

    if (type == "proc_list_result")
    {
        m_processEntries = json.value("processes").toArray().toVariantList();
        emit processesChanged();
        return;
    }

    if (type == "proc_kill_result")
    {
        refreshProcesses();
        return;
    }
}

void OrbitBackend::disconnectSession()
{
    if (m_sessionSocket)
    {
        m_sessionSocket->disconnect(this);
        m_sessionSocket->abort();
        m_sessionSocket->deleteLater();
        m_sessionSocket = nullptr;
    }
    m_sessionReadBuffer.clear();
    if (m_canvas) m_canvas->clearCanvas();

    if (m_connected || m_connecting)
    {
        m_connected = false;
        m_connecting = false;
        m_privacyCurtain = false;
        emit sessionStateChanged();
        refreshComputers();
    }
}

void OrbitBackend::sendMouse(const QString& action, double normX, double normY, const QString& button, int deltaX, int deltaY)
{
    if (!m_connected || !m_sessionSocket) return;
    QJsonObject msg;
    msg["type"] = "mouse";
    msg["action"] = action;
    msg["x"] = normX;
    msg["y"] = normY;
    msg["button"] = button;
    msg["deltaX"] = deltaX;
    msg["deltaY"] = deltaY;
    writeFrame(m_sessionSocket, msg);
}

void OrbitBackend::sendKeyEvent(const QString& action, int qtKey, int modifiers, const QString& text)
{
    if (!m_connected || !m_sessionSocket) return;

    const int vk = qtKeyToWindowsVk(qtKey, text);
    if (vk == 0)
    {
        if (action == "down" && !text.isEmpty() && text.at(0).isPrint())
            sendText(text);
        return;
    }

    bool ctrl = (modifiers & Qt::ControlModifier) != 0;
    bool meta = (modifiers & Qt::MetaModifier) != 0;
    const bool alt = (modifiers & Qt::AltModifier) != 0;
    const bool shift = (modifiers & Qt::ShiftModifier) != 0;

#ifdef Q_OS_MACOS
    // On macOS Qt, Qt::ControlModifier is Command (⌘) and Qt::MetaModifier is physical Control (⌃).
    if (m_mapCommandToCtrl)
    {
        ctrl = ctrl || meta;
        meta = false;
    }
#endif

    QJsonObject msg;
    msg["type"] = "key";
    msg["action"] = action;
    msg["vk"] = vk;
    msg["ctrl"] = ctrl;
    msg["alt"] = alt;
    msg["shift"] = shift;
    msg["win"] = meta;
    writeFrame(m_sessionSocket, msg);
}

void OrbitBackend::sendText(const QString& text)
{
    if (!m_connected || !m_sessionSocket || text.isEmpty()) return;
    QJsonObject msg;
    msg["type"] = "text";
    msg["text"] = text;
    writeFrame(m_sessionSocket, msg);
}

void OrbitBackend::sendCtrlAltDel()
{
    if (!m_connected || !m_sessionSocket) return;
    QJsonObject msg;
    msg["type"] = "sas";
    writeFrame(m_sessionSocket, msg);
    setStatus("Sent Ctrl+Alt+Del (Secure Attention Sequence) to PC.");
}

void OrbitBackend::setQualityPreset(const QString& quality)
{
    m_qualityMode = quality;
    saveSettings();
    emit qualityModeChanged();

    if (m_connected && m_sessionSocket)
    {
        QJsonObject msg;
        msg["type"] = "display_config";
        msg["quality"] = m_qualityMode;
        msg["monitor"] = m_selectedMonitor;
        writeFrame(m_sessionSocket, msg);
    }
}

void OrbitBackend::selectMonitor(int monitorIndex)
{
    m_selectedMonitor = monitorIndex;
    emit sessionStateChanged();
    if (m_connected && m_sessionSocket)
    {
        QJsonObject msg;
        msg["type"] = "display_config";
        msg["monitor"] = m_selectedMonitor;
        msg["quality"] = m_qualityMode;
        writeFrame(m_sessionSocket, msg);
    }
}

void OrbitBackend::matchClientResolution(int width, int height)
{
    if (!m_connected || !m_sessionSocket) return;
    QJsonObject msg;
    msg["type"] = "display_config";
    msg["monitor"] = m_selectedMonitor;
    msg["quality"] = m_qualityMode;
    msg["width"] = width;
    msg["height"] = height;
    writeFrame(m_sessionSocket, msg);
    setStatus(QString("Requested PC resolution %1 × %2.").arg(width).arg(height));
}

void OrbitBackend::restoreHostResolution()
{
    if (!m_connected || !m_sessionSocket) return;
    QJsonObject msg;
    msg["type"] = "display_config";
    msg["restoreResolution"] = true;
    writeFrame(m_sessionSocket, msg);
    setStatus("Restored native PC display resolution.");
}

void OrbitBackend::togglePrivacyCurtain()
{
    if (!m_connected || !m_sessionSocket) return;
    QJsonObject msg;
    msg["type"] = "privacy_curtain";
    msg["enabled"] = !m_privacyCurtain;
    writeFrame(m_sessionSocket, msg);
}

void OrbitBackend::syncClipboardToPc()
{
    if (!m_connected || !m_sessionSocket || !QGuiApplication::clipboard()) return;
    const QString text = QGuiApplication::clipboard()->text();
    if (text.isEmpty()) return;
    QJsonObject msg;
    msg["type"] = "clipboard_set";
    msg["text"] = text;
    writeFrame(m_sessionSocket, msg);
    setStatus("Synced Mac clipboard to PC.");
}

void OrbitBackend::pullClipboardFromPc()
{
    if (!m_connected || !m_sessionSocket) return;
    QJsonObject msg;
    msg["type"] = "clipboard_get";
    writeFrame(m_sessionSocket, msg);
}

void OrbitBackend::runCommand(const QString& command, const QString& shell)
{
    if (!m_connected || !m_sessionSocket || command.trimmed().isEmpty()) return;
    m_terminalBusy = true;
    m_terminalOutput += QString("%1> %2\n").arg(m_terminalCwd, command);
    emit terminalChanged();

    QJsonObject msg;
    msg["type"] = "exec_cmd";
    msg["id"] = QString::number(++m_cmdCounter);
    msg["command"] = command;
    msg["shell"] = shell;
    writeFrame(m_sessionSocket, msg);
}

void OrbitBackend::clearTerminal()
{
    m_terminalOutput.clear();
    emit terminalChanged();
}

void OrbitBackend::browsePath(const QString& path)
{
    if (!m_connected || !m_sessionSocket) return;
    QJsonObject msg;
    msg["type"] = "fs_list";
    msg["path"] = path;
    writeFrame(m_sessionSocket, msg);
}

void OrbitBackend::downloadFile(const QString& remotePath)
{
    if (!m_connected || !m_sessionSocket || remotePath.isEmpty()) return;
    QJsonObject msg;
    msg["type"] = "fs_download";
    msg["path"] = remotePath;
    writeFrame(m_sessionSocket, msg);
}

void OrbitBackend::uploadSampleNote(const QString& fileName, const QString& content)
{
    if (!m_connected || !m_sessionSocket || m_currentFsPath.isEmpty() || fileName.trimmed().isEmpty()) return;
    const QString sep = m_currentFsPath.endsWith('\\') ? "" : "\\";
    const QString dest = m_currentFsPath + sep + fileName.trimmed();
    QJsonObject msg;
    msg["type"] = "fs_upload";
    msg["path"] = dest;
    writeFrame(m_sessionSocket, msg, content.toUtf8());
}

void OrbitBackend::uploadLocalFile(const QString& localPath)
{
    if (!m_connected || !m_sessionSocket || m_currentFsPath.isEmpty() || localPath.trimmed().isEmpty()) return;
    QString cleanPath = localPath.trimmed();
    if (cleanPath.startsWith("file://"))
        cleanPath = QUrl(cleanPath).toLocalFile();

    QFile file(cleanPath);
    if (!file.open(QIODevice::ReadOnly))
    {
        setStatus("Could not read local file: " + cleanPath);
        return;
    }
    const QByteArray bytes = file.readAll();
    const QString name = QFileInfo(cleanPath).fileName();
    const QString sep = m_currentFsPath.endsWith('\\') ? "" : "\\";
    QJsonObject msg;
    msg["type"] = "fs_upload";
    msg["path"] = m_currentFsPath + sep + name;
    writeFrame(m_sessionSocket, msg, bytes);
    setStatus("Uploading " + name + " to PC…");
}

void OrbitBackend::deleteRemotePath(const QString& remotePath)
{
    if (!m_connected || !m_sessionSocket || remotePath.isEmpty()) return;
    QJsonObject msg;
    msg["type"] = "fs_delete";
    msg["path"] = remotePath;
    writeFrame(m_sessionSocket, msg);
}

void OrbitBackend::refreshProcesses()
{
    if (!m_connected || !m_sessionSocket) return;
    QJsonObject msg;
    msg["type"] = "proc_list";
    writeFrame(m_sessionSocket, msg);
}

void OrbitBackend::killProcess(int pid)
{
    if (!m_connected || !m_sessionSocket || pid <= 0) return;
    QJsonObject msg;
    msg["type"] = "proc_kill";
    msg["pid"] = pid;
    writeFrame(m_sessionSocket, msg);
}

void OrbitBackend::sendPowerAction(const QString& action)
{
    if (!m_connected || !m_sessionSocket) return;
    QJsonObject msg;
    msg["type"] = "sys_power";
    msg["action"] = action;
    writeFrame(m_sessionSocket, msg);
}

void OrbitBackend::writeFrame(QSslSocket* socket, const QJsonObject& json, const QByteArray& binary)
{
    if (!socket || socket->state() != QAbstractSocket::ConnectedState) return;
    const QByteArray jsonBytes = QJsonDocument(json).toJson(QJsonDocument::Compact);
    char header[8];
    qToBigEndian<qint32>(jsonBytes.size(), reinterpret_cast<uchar*>(header));
    qToBigEndian<qint32>(binary.size(), reinterpret_cast<uchar*>(header + 4));
    socket->write(header, 8);
    socket->write(jsonBytes);
    if (!binary.isEmpty())
        socket->write(binary);
    socket->flush();
}

bool OrbitBackend::tryExtractFrame(QByteArray& buffer, QJsonObject& outJson, QByteArray& outBinary)
{
    if (buffer.size() < 8) return false;
    const qint32 jsonLen = qFromBigEndian<qint32>(reinterpret_cast<const uchar*>(buffer.constData()));
    const qint32 binLen = qFromBigEndian<qint32>(reinterpret_cast<const uchar*>(buffer.constData() + 4));
    if (jsonLen <= 0 || jsonLen > 4 * 1024 * 1024 || binLen < 0 || binLen > 32 * 1024 * 1024)
    {
        buffer.clear();
        return false;
    }
    const int total = 8 + jsonLen + binLen;
    if (buffer.size() < total) return false;

    const QByteArray jsonBytes = buffer.mid(8, jsonLen);
    outBinary = (binLen > 0) ? buffer.mid(8 + jsonLen, binLen) : QByteArray();
    buffer.remove(0, total);

    outJson = QJsonDocument::fromJson(jsonBytes).object();
    return true;
}

QString OrbitBackend::computePairingCommitment(const QString& pin, const QString& certSha256Hex, const QString& clientId, const QString& tokenHashHex)
{
    const QByteArray keyMaterial = QString("%1:%2").arg(pin.trimmed(), certSha256Hex.toLower()).toUtf8();
    const QByteArray key = QCryptographicHash::hash(keyMaterial, QCryptographicHash::Sha256);
    const QByteArray msg = QString("%1:%2").arg(clientId, tokenHashHex.toLower()).toUtf8();
    const QByteArray mac = QMessageAuthenticationCode::hash(msg, key, QCryptographicHash::Sha256);
    return QString::fromLatin1(mac.toHex()).toLower();
}

QString OrbitBackend::computeAuthProof(const QString& tokenHashHex, const QString& serverNonce, const QString& certSha256Hex)
{
    const QByteArray key = QByteArray::fromHex(tokenHashHex.toLatin1());
    const QByteArray msg = QString("%1:%2").arg(serverNonce, certSha256Hex.toLower()).toUtf8();
    const QByteArray mac = QMessageAuthenticationCode::hash(msg, key, QCryptographicHash::Sha256);
    return QString::fromLatin1(mac.toHex()).toLower();
}

int OrbitBackend::qtKeyToWindowsVk(int qtKey, const QString& text)
{
    if (qtKey >= Qt::Key_A && qtKey <= Qt::Key_Z)
        return 0x41 + (qtKey - Qt::Key_A);
    if (qtKey >= Qt::Key_0 && qtKey <= Qt::Key_9)
        return 0x30 + (qtKey - Qt::Key_0);
    if (qtKey >= Qt::Key_F1 && qtKey <= Qt::Key_F12)
        return 0x70 + (qtKey - Qt::Key_F1);

    switch (qtKey)
    {
        case Qt::Key_Return:
        case Qt::Key_Enter: return 0x0D;
        case Qt::Key_Escape: return 0x1B;
        case Qt::Key_Backspace: return 0x08;
        case Qt::Key_Tab: return 0x09;
        case Qt::Key_Space: return 0x20;
        case Qt::Key_Delete: return 0x2E;
        case Qt::Key_Insert: return 0x2D;
        case Qt::Key_Home: return 0x24;
        case Qt::Key_End: return 0x23;
        case Qt::Key_PageUp: return 0x21;
        case Qt::Key_PageDown: return 0x22;
        case Qt::Key_Left: return 0x25;
        case Qt::Key_Up: return 0x26;
        case Qt::Key_Right: return 0x27;
        case Qt::Key_Down: return 0x28;
        case Qt::Key_Shift: return 0x10;
        case Qt::Key_Control: return 0x11;
        case Qt::Key_Alt: return 0x12;
        case Qt::Key_Meta: return 0x5B;
        case Qt::Key_CapsLock: return 0x14;
        case Qt::Key_Minus: return 0xBD;
        case Qt::Key_Equal: return 0xBB;
        case Qt::Key_BracketLeft: return 0xDB;
        case Qt::Key_BracketRight: return 0xDD;
        case Qt::Key_Backslash: return 0xDC;
        case Qt::Key_Semicolon: return 0xBA;
        case Qt::Key_Apostrophe: return 0xDE;
        case Qt::Key_Comma: return 0xBC;
        case Qt::Key_Period: return 0xBE;
        case Qt::Key_Slash: return 0xBF;
        case Qt::Key_QuoteLeft: return 0xC0;
        default: break;
    }

    Q_UNUSED(text);
    return 0;
}
