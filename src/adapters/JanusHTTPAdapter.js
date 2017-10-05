var INetworkAdapter = require("./INetworkAdapter");

var charSet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomString(len) {
  var str = "";

  for (var i = 0; i < len; i++) {
    var randomPoz = Math.floor(Math.random() * charSet.length);
    str += charSet.substring(randomPoz, randomPoz + 1);
  }

  return str;
}

class JanusAdapter extends INetworkAdapter {
  constructor() {
    super();

    this.app = "default";
    this.room = "default";
    this.userId = randomString(12);

    this.janusServerUrl = null;
    this.janusSessionUrl = null;
    this.retproxyUrl = null;

    this.rtcPeer = null;
    this.unreliableChannel = null;
    this.reliableChannel = null;

    this.lastMessageSent = null;

    this.onDataChannelMessage = this.onDataChannelMessage.bind(this);
    this.onIceCandidate = this.onIceCandidate.bind(this);
  }

  setServerUrl(url) {
    this.janusServerUrl = url;
  }

  setApp(app) {
    this.app = app;
  }

  setRoom(roomName) {
    this.room = roomName;
  }

  setWebRtcOptions(options) {
    console.log("setWebRtcOptions:", options);
  }

  setServerConnectListeners(successListener, failureListener) {
    this.connectSuccess = successListener;
    this.connectFailure = failureListener;
  }

  setRoomOccupantListener(occupantListener) {
    this.occupantListener = occupantListener;
  }

  setDataChannelListeners(openListener, closedListener, messageListener) {
    this.openListener = openListener;
    this.closedListener = closedListener;
    this.messageListener = messageListener;
  }

  connect() {
    this.setupWebRtcPeer();
  }

  async janusPostJson(url, body) {
    var response = await fetch(url, {
      method: "POST",
      body: JSON.stringify(body)
    });

    this.lastMessageSent = Date.now();

    return response.json();
  }

  async janusGetJson(url) {
    var response = await fetch(url);

    this.lastMessageSent = Date.now();

    return response.json();
  }

  async setupWebRtcPeer() {
    // Create the Janus Session
    var sessionResponse = await this.janusPostJson(this.janusServerUrl, {
      janus: "create",
      transaction: randomString(12)
    });

    var janusSessionId = sessionResponse.data.id;

    this.janusSessionUrl = this.janusServerUrl + "/" + janusSessionId;

    // Attach Reticulum proxy plugin to Janus.
    var retproxyResponse = await this.janusPostJson(this.janusSessionUrl, {
      janus: "attach",
      plugin: "janus.plugin.retproxy",
      "force-bundle": true,
      "force-rtcp-mux": true,
      transaction: randomString(12)
    });

    var retproxyHandle = retproxyResponse.data.id;

    this.retproxyUrl = this.janusSessionUrl + "/" + retproxyHandle;

    // Create a new WebRTC peer. All other client data will be multiplexed through this connection.
    this.rtcPeer = new RTCPeerConnection({
      iceServers: [
        {
          urls: "stun:stun.l.google.com:19302"
        },
        {
          urls: "stun:global.stun.twilio.com:3478?transport=udp"
        }
      ]
    });

    this.unreliableChannel = this.rtcPeer.createDataChannel("unreliable", {
      ordered: false,
      maxRetransmits: 0
    });

    this.unreliableChannel.addEventListener(
      "message",
      this.onDataChannelMessage
    );

    this.reliableChannel = this.rtcPeer.createDataChannel("reliable", {
      ordered: true
    });

    this.reliableChannel.addEventListener("message", this.onDataChannelMessage);

    this.rtcPeer.addEventListener("icecandidate", this.onIceCandidate);

    var offer = await this.rtcPeer.createOffer();
    await this.rtcPeer.setLocalDescription(offer);

    await this.janusPostJson(this.retproxyUrl, {
      janus: "message",
      body: {
        kind: "publisher"
      },
      transaction: randomString(12),
      jsep: offer
    });

    while (true) {
      var eventResponse = await this.janusGetJson(this.janusSessionUrl);

      if (eventResponse.jsep) {
        await this.rtcPeer.setRemoteDescription(eventResponse.jsep);
        break;
      }
    }

    while (true) {
      var eventResponse = await this.janusGetJson(this.janusSessionUrl);

      if (eventResponse.janus === "webrtcup") {
        break;
      }
    }

    this.connectSuccess();

    this.startPolling();
  }

  onIceCandidate(event) {
    var candidate = event.candidate || { completed: true };

    this.janusPostJson(this.retproxyUrl, {
      janus: "trickle",
      transaction: randomString(12),
      candidate
    });
  }

  async startPolling() {
    while (true) {
      var eventResponse = await this.janusGetJson(this.janusSessionUrl);
    }
  }

  onDataChannelMessage(message) {
    console.log(message);
  }

  shouldStartConnectionTo(clientId) {
    return true;
  }

  startStreamConnection(clientId) {
    this.connectedClients.push(clientId);
    this.openListener(clientId);
  }

  closeStreamConnection(clientId) {
    var index = this.connectedClients.indexOf(clientId);
    if (index > -1) {
      this.connectedClients.splice(index, 1);
    }
    this.closedListener(clientId);
  }

  getConnectStatus(clientId) {
    if (this.connectedClients.indexOf(clientId) === -1) {
      return INetworkAdapter.NOT_CONNECTED;
    } else {
      return INetworkAdapter.IS_CONNECTED;
    }
  }

  getAudioStream(clientId) {
    return Promise.reject("Interface method not implemented: getAudioStream");
  }

  enableMicrophone(enabled) {
    this.notImplemented("enableMicrophone");
  }

  sendData(clientId, dataType, data) {
    this.unreliableChannel.send(JSON.stringify({ clientId, dataType, data }));
  }

  sendDataGuaranteed(clientId, dataType, data) {
    // TODO: Add reliable datachannel support
    this.reliableChannel.send(JSON.stringify({ clientId, dataType, data }));
  }

  broadcastData(dataType, data) {
    this.unreliableChannel.send(JSON.stringify({ dataType, data }));
  }

  broadcastDataGuaranteed(dataType, data) {
    this.reliableChannel.send(JSON.stringify({ dataType, data }));
  }
}

module.exports = JanusAdapter;
