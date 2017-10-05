var SimplePeer = require("simple-peer");
var INetworkAdapter = require("./INetworkAdapter");
var WebRtcPeer = require("./WebRtcPeer");

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

    this.janusServer = null;
    this.janusServerUrl = null;
    this.janusSessionId = null;
    this.transactions = {};
    this.transactionTimeouts = {};
    this.retproxyHandle = null;

    this.rtcPeer = null;
    this.unreliableChannel = null;
    this.reliableChannel = null;

    this.connectedClients = [];

    this.onSignalError = this.onSignalError.bind(this);
    this.onSignalMessage = this.onSignalMessage.bind(this);
    this.sendKeepAliveMessage = this.sendKeepAliveMessage.bind(this);
    this.onNegotiationNeeded = this.onNegotiationNeeded.bind(this);
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
    this.janusServer = new WebSocket(this.janusServerUrl, "janus-protocol");

    this.janusServer.addEventListener("open", _ => this.setupWebRtcPeer());
    this.janusServer.addEventListener("error", this.onSignalError);
    this.janusServer.addEventListener("message", this.onSignalMessage);
  }

  async setupWebRtcPeer() {
    // Create the Janus Session
    var sessionResponse = await this.sendSignalMessagePromise(
      {
        janus: "create"
      },
      30000
    );

    this.janusSessionId = sessionResponse.data.id;

    // Send keep alive messages now and then every 30 seconds.
    // TODO: only send keep alive messages after 30 seconds of inactivity.
    this.sendKeepAliveMessage();

    // Attach Reticulum proxy plugin to Janus.
    var retproxyResponse = await this.sendSignalMessagePromise(
      {
        janus: "attach",
        session_id: this.janusSessionId,
        plugin: "janus.plugin.retproxy",
        "force-bundle": true,
        "force-rtcp-mux": true
      },
      30000
    );

    this.retproxyHandle = retproxyResponse.data.id;

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

    var answer = await this.sendSignalMessagePromise(
      {
        janus: "message",
        body: {
          kind: "publisher"
        },
        session_id: this.janusSessionId,
        handle_id: this.retproxyHandle,
        jsep
      },
      3000
    );

    await this.rtcPeer.setRemoteDescription(answer.jsep);

    this.connectSuccess();
  }

  onIceCandidate(event) {
    var candidate = event.candidate || { completed: true };

    this.sendSignalMessage({
      janus: "trickle",
      session_id: this.janusSessionId,
      handle_id: this.retproxyHandle,
      candidate
    });
  }

  sendSignalMessagePromise(message, timeout) {
    return new Promise((resolve, reject) => {
      this.sendSignalMessage(
        message,
        (error, response) => {
          if (error !== undefined) {
            reject(error);
            return;
          }

          resolve(response);
        },
        timeout
      );
    });
  }

  sendKeepAliveMessage() {
    this.sendSignalMessage({
      janus: "keepalive",
      session_id: this.janusSessionId
    });

    this.keepAliveTimeout = setTimeout(
      () => this.sendKeepAliveMessage(),
      30000
    );
  }

  sendSignalMessage(message, callback, timeout) {
    if (this.janusServer !== null && this.janusServer.readyState === 1) {
      var transaction = (message.transaction = randomString(12));
      this.janusServer.send(JSON.stringify(message));

      if (callback !== undefined) {
        this.transactions[transaction] = callback;
      }

      if (timeout !== undefined) {
        this.transactionTimeouts[transaction] = setTimeout(() => {
          callback(new Error("Transaction timed out"));
        }, timeout);
      }

      return transaction;
    }

    // TODO: Should it throw an error or return null?
    return null;
  }

  onSignalError(error) {
    console.error("Signal server error:", error);
  }

  onSignalMessage(message) {
    var json = JSON.parse(message.data);

    switch (json.janus) {
      case "success":
        this.onSignalMessageSuccess(json);
        break;
      case "error":
        this.onSignalMessageError(json);
      case "ack":
        this.onSignalMessageAck(json);
        break;
      case "event":
        this.onSignalMessageEvent(json);
        break;
      case "webrtcup":
        this.onSignalMessageWebRtcUp(json);
        break;
      default:
        console.log("Unknown janus response:", message);
        break;
    }
  }

  onSignalMessageSuccess(message) {
    var transaction = message.transaction;

    if (transaction && this.transactions[transaction]) {
      console.log("Signal message success", message);
      this.transactions[transaction](undefined, message);

      if (this.transactionTimeouts[transaction]) {
        clearTimeout(this.transactionTimeouts[transaction]);
      }
    }
  }

  onSignalMessageError(message) {
    var transaction = message.transaction;

    if (transaction && this.transactions[transaction]) {
      this.transactions[transaction](new Error(message.error));

      if (this.transactionTimeouts[transaction]) {
        clearTimeout(this.transactionTimeouts[transaction]);
      }
    } else {
      console.error("Unhandled signal server error:", message);
    }
  }

  onSignalMessageEvent(message) {
    var transaction = message.transaction;

    if (transaction && this.transactions[transaction]) {
      console.log("Signal message event", message);
      this.transactions[transaction](undefined, message);

      if (this.transactionTimeouts[transaction]) {
        clearTimeout(this.transactionTimeouts[transaction]);
      }
    }
  }

  onSignalMessageAck(message) {
    console.log("Ack:", message);
  }

  onSignalMessageWebRtcUp(message) {
    console.log("WebRTC Up!", message);
    this.openListener();
  }

  onDataChannelMessage(message) {
    console.log("data channel message:", message);
    this.messageListener(message);
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
