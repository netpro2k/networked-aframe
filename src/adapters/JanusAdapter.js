var SimplePeer = require("simple-peer");
var INetworkAdapter = require("./INetworkAdapter");
var { EventIterator } = require("event-iterator");

function makeWebsocketIterator(ws) {
  var messageListener;
  var closeListener;
  var errorListener;

  var listenHandler = function(push, stop, fail) {
    messageListener = event => {
      push(JSON.parse(event.data));
    };

    closeListener = event => {
      stop();
    };

    errorListener = event => {
      fail(event.error);
    };

    ws.addEventListener("message", messageListener);
    ws.addEventListener("close", closeListener);
    ws.addEventListener("error", errorListener);
  };

  var removeHandler = function(push, stop, fail) {
    ws.removeEventListener("message", messageListener);
    ws.removeEventListener("close", closeListener);
    ws.removeEventListener("error", errorListener);
  };

  return new EventIterator(listenHandler, removeHandler);
}

var charSet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomString(len) {
  var str = "";

  for (var i = 0; i < len; i++) {
    var randomPoz = Math.floor(Math.random() * charSet.length);
    str += charSet.substring(randomPoz, randomPoz + 1);
  }

  return str;
}

const MessageType = {
  JOIN_ROOM: 0,
  OCCUPANT: 1
};

class JanusAdapter extends INetworkAdapter {
  constructor() {
    super();

    this.app = "default";
    this.room = "default";
    this.clientId = null;

    this.janusServer = null;
    this.janusServerUrl = null;
    this.janusSessionId = null;
    this.retproxyHandle = null;

    this.rtcPeer = null;
    this.unreliableChannel = null;
    this.reliableChannel = null;

    this.connectedClients = [];

    this.sendKeepAliveMessage = this.sendKeepAliveMessage.bind(this);
    this.onDataChannelMessage = this.onDataChannelMessage.bind(this);
    this.onIceCandidate = this.onIceCandidate.bind(this);
    this.onDataChannelOpen = this.onDataChannelOpen.bind(this);
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

  setWebRtcOptions(options) {}

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
    this.janusServer.addEventListener("open", () => this.setup());
  }

  async setup() {
    // Send keep alive messages now and then every 30 seconds.
    // TODO: only send keep alive messages after 30 seconds of inactivity.
    this.sendKeepAliveMessage();

    var messages = makeWebsocketIterator(this.janusServer);

    // Create Janus session
    var sessionTransaction = randomString(12);
    this.janusServer.send(
      JSON.stringify({
        janus: "create",
        transaction: sessionTransaction
      })
    );

    for await (let message of messages) {
      if (message.transaction && message.transaction === sessionTransaction) {
        if (message.janus && message.janus === "success") {
          this.janusSessionId = message.data.id;
          break;
        } else {
          throw new Error(message.error);
        }
      }
    }

    // Attach Reticulum Janus plugin.
    var pluginTransaction = randomString(12);
    this.janusServer.send(
      JSON.stringify({
        janus: "attach",
        session_id: this.janusSessionId,
        plugin: "janus.plugin.retproxy",
        "force-bundle": true,
        "force-rtcp-mux": true,
        transaction: pluginTransaction
      })
    );

    for await (let message of messages) {
      if (message.transaction && message.transaction === pluginTransaction) {
        if (message.janus && message.janus === "success") {
          this.retproxyHandle = message.data.id;
          break;
        } else {
          throw new Error(message.error);
        }
      }
    }

    // Create the RTCPeerConnection
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

    this.rtcPeer.addEventListener("icecandidate", this.onIceCandidate);

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
    this.reliableChannel.addEventListener("open", this.onDataChannelOpen);

    // Create, set, and send the WebRTC offer.
    var offer = await this.rtcPeer.createOffer();
    await this.rtcPeer.setLocalDescription(offer);

    var publisherTransactionId = randomString(12);

    this.janusServer.send(
      JSON.stringify({
        janus: "message",
        body: {
          kind: "join",
          role: "publisher"
        },
        session_id: this.janusSessionId,
        handle_id: this.retproxyHandle,
        jsep: offer,
        transaction: publisherTransactionId
      })
    );

    // Wait for multiple responses from the server
    for await (let message of messages) {
      if (
        message.transaction &&
        message.transaction === publisherTransactionId
      ) {
        // Set the
        if (message.jsep) {
          await this.rtcPeer.setRemoteDescription(message.jsep);
        } else if (
          message.plugindata &&
          message.plugindata.data &&
          message.plugindata.data.event &&
          message.plugindata.data.event === "join_self"
        ) {
          this.clientId = message.plugindata.data.user_id;
          this.occupants = message.plugindata.data.user_ids;
        }

        if (this.rtcPeer.remoteDescription && this.clientId) {
          break;
        }
      }
    }

    // Handle leave and join events
    for await (let message of messages) {
      if (
        message.plugindata &&
        message.plugindata.data &&
        message.sender === this.retproxyHandle
      ) {
        var data = message.plugindata.data;

        if (data.event === "join_other") {
          var idx = this.occupants.indexOf(data.user_id);

          if (idx === -1) {
            this.occupants.push(data.user_id);
            this.openListener(data.user_id);
            this.occupantListener(this.occupants);
          }
        } else if (data.event === "leave") {
          var idx = this.occupants.indexOf(data.user_id);

          if (idx !== -1) {
            this.occupants.splice(idx, 1);
            this.closedListener(data.user_id);
            this.occupantListener(this.occupants);
          }
        }
      }
    }
  }

  onDataChannelOpen() {
    var clientId = this.clientId;
    this.reliableChannel.send(
      JSON.stringify({
        type: MessageType.JOIN_ROOM,
        clientId
      })
    );
    this.connectSuccess(clientId);
  }

  onIceCandidate(event) {
    var candidate = event.candidate || { completed: true };

    this.janusServer.send(
      JSON.stringify({
        janus: "trickle",
        session_id: this.janusSessionId,
        handle_id: this.retproxyHandle,
        candidate,
        transaction: randomString(12)
      })
    );
  }

  sendKeepAliveMessage() {
    this.janusServer.send(
      JSON.stringify({
        janus: "keepalive",
        session_id: this.janusSessionId,
        transaction: randomString(12)
      })
    );

    this.keepAliveTimeout = setTimeout(
      () => this.sendKeepAliveMessage(),
      30000
    );
  }

  onDataChannelMessage(event) {
    var message = JSON.parse(event.data);
    //console.log("data channel message:", message);

    if (message.dataType) {
      this.messageListener(null, message.dataType, message.data);
    }
  }

  shouldStartConnectionTo(clientId) {
    return true;
  }

  startStreamConnection(clientId) {}

  closeStreamConnection(clientId) {}

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
    var message = { clientId, dataType, data };
    //console.log("sendData", message);
    this.unreliableChannel.send(JSON.stringify(message));
  }

  sendDataGuaranteed(clientId, dataType, data) {
    var message = { clientId, dataType, data };
    //console.log("sendDataGuaranteed", message);
    this.reliableChannel.send(JSON.stringify(message));
  }

  broadcastData(dataType, data) {
    var message = { dataType, data };
    //console.log("broadcastData", message);
    this.unreliableChannel.send(JSON.stringify(message));
  }

  broadcastDataGuaranteed(dataType, data) {
    var message = { dataType, data };
    //console.log("broadcastDataGuaranteed", message);
    this.reliableChannel.send(JSON.stringify(message));
  }
}

module.exports = JanusAdapter;
