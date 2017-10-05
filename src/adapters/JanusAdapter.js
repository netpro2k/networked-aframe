var SimplePeer = require("simple-peer");
var INetworkAdapter = require('./INetworkAdapter');

var charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomString(len) {
  var str = '';
  
  for (var i = 0; i < len; i++) {
    var randomPoz = Math.floor(Math.random() * charSet.length);
    str += charSet.substring(randomPoz, randomPoz + 1);
  }

  return str;
}

class JanusAdapter extends INetworkAdapter {

  constructor() {
    super();
    
    this.app = 'default';
    this.room = 'default';
    this.userId = randomString(12);

    this.signalServer = null;
    this.signalServerUrl = null;
    this.signalSessionId = null;
    this.signalTranactions = {};
    this.transactionTimeouts = {};
    this.retproxyHandle = null;

    this.rtcPeer = null;

    this.connectedClients = [];

    this.onSignalConnect = this.onSignalConnect.bind(this);
    this.onSignalError = this.onSignalError.bind(this);
    this.onSignalMessage = this.onSignalMessage.bind(this);
    this.sendKeepAliveMessage = this.sendKeepAliveMessage.bind(this);
  }

  setServerUrl(url) {
    this.signalServerUrl = url;
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
    this.signalServer = new WebSocket(this.signalServerUrl, 'janus-protocol');

    this.signalServer.addEventListener('open', this.onSignalConnect);
    this.signalServer.addEventListener('error', this.onSignalError);
    this.signalServer.addEventListener('message', this.onSignalMessage);
  }

  onSignalConnect() {
    console.log("Signal server connected.");
    this.setupWebRtcPeer();
  }

  async setupWebRtcPeer() {
    var sessionResponse = await this.sendSignalMessagePromise({
      janus: "create"
    }, 30000);

    this.signalSessionId = sessionResponse.data.id;
    
    var retproxyResponse = await this.sendSignalMessagePromise({
      janus: "attach",
      session_id: this.signalSessionId,
      plugin: "janus.plugin.retproxy",
      "opaque_id": this.userId,
      "force-bundle":true,
      "force-rtcp-mux":true
    }, 30000);

    this.retproxyHandle = retproxyResponse.data.id;

    this.rtcPeer = new SimplePeer({ initiator: true });

    this.rtcPeer.on("signal", (message) => {
      if (message.type === "offer") {
        this.sendOfferMessage(message);
      } else if (message.candidate) {
        this.sendCandidateMessage(message.candidate);
      }
    });
    
    this.rtcPeer.on("error", (error) => {
      console.error("RTCPeer error:", error);
    });

    this.rtcPeer.on("connect", () => {
      console.log("RTCPeer connected.");
    });

    this.rtcPeer.on("data", (data) => {
      console.log("RTCPeer data received:", data);
    });

    this.sendKeepAliveMessage();
  }

  sendOfferMessage(jsep) {
    this.sendSignalMessage({
      janus: "message",
      body: {
        kind: "publisher"
      },
      session_id: this.signalSessionId,
      handle_id: this.retproxyHandle,
      jsep
    });
  }

  sendCandidateMessage(candidate) {
    this.sendSignalMessage({
      janus: "trickle",
      session_id: this.signalSessionId,
      handle_id: this.retproxyHandle,
      candidate,
    });
  }

  onSignalError(error) {
    console.error("Signal server error:", error);
  }

  onSignalMessage(message) {
    var json = JSON.parse(message.data);

    switch(json.janus) {
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

  sendSignalMessage(message, callback, timeout) {
    if (this.isSignalServerConnected()) {
      var transaction = message.transaction = randomString(12);
      this.signalServer.send(JSON.stringify(message));

      if (callback !== undefined) {
        this.signalTranactions[transaction] = callback;
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

  sendSignalMessagePromise(message, timeout) {
    return new Promise((resolve, reject) => {
      this.sendSignalMessage(message, (error, response) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve(response);
      }, timeout);
    });
  }

  onSignalMessageSuccess(message) {
    var transaction = message.transaction;
    
    if (transaction && this.signalTranactions[transaction]) {
      this.signalTranactions[transaction](undefined, message);

      if (this.transactionTimeouts[transaction]) {
        clearTimeout(this.transactionTimeouts[transaction]);
      }
    }
  }

  onSignalMessageError(message) {
    var transaction = message.transaction;
    
    if (transaction && this.signalTranactions[transaction]) {
      this.signalTranactions[transaction](new Error(message.error));

      if (this.transactionTimeouts[transaction]) {
        clearTimeout(this.transactionTimeouts[transaction]);
      }
    } else {
      console.error("Unhandled signal server error:", message);
    }
  }

  onSignalMessageEvent(message) {
    if (message.sender === this.retproxyHandle) {
      if (message.jsep !== undefined) {
        this.rtcPeer.signal(message.jsep);
      }
    } else {
      console.log("Unhandled event:", event);
    }
  }

  onSignalMessageAck(message) {
    console.log("Ack:", message);
  }

  onSignalMessageWebRtcUp(message) {
    console.log("WebRTC Up!", message);
    this.openListener()
  }

  isSignalServerConnected() {
    return this.signalServer !== null && this.signalServer.readyState === 1;
  }

  sendKeepAliveMessage() {
    console.log("sendKeepAliveMessage");

    this.sendSignalMessage({
      janus: "keepalive",
      session_id: this.signalSessionId,
    });

    this.keepAliveTimeout = setTimeout(() => this.sendKeepAliveMessage(), 30000);
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
    this.notImplemented('enableMicrophone');
  }

  sendData(clientId, dataType, data) {
    this.rtcPeer.send({ clientId, dataType, data });
  }

  sendDataGuaranteed(clientId, dataType, data) {
    // TODO: Add reliable datachannel support
    this.rtcPeer.send({ clientId, dataType, data });
  }

  broadcastData(dataType, data) {
    this.rtcPeer.send({ dataType, data });
  }

  broadcastDataGuaranteed(dataType, data) {
    this.rtcPeer.send({ dataType, data });
  }
}

module.exports = JanusAdapter;
