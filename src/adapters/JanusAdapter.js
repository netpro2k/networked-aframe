var SimplePeer = require("simple-peer");
var INetworkAdapter = require("./INetworkAdapter");
var { EventIterator } = require("event-iterator");

var charSet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const PEER_CONNECTION_CONFIG = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302"
    },
    {
      urls: "stun:global.stun.twilio.com:3478?transport=udp"
    }
  ]
};

function randomString(len) {
  var str = "";

  for (var i = 0; i < len; i++) {
    var randomPoz = Math.floor(Math.random() * charSet.length);
    str += charSet.substring(randomPoz, randomPoz + 1);
  }

  return str;
}

function sendSignal(ws, message) {
  if (ws.readyState !== 1) {
    throw new Error("Websocket not connected!");
  }

  message.transaction = randomString(12);
  ws.send(JSON.stringify(message));
  return message.transaction;
}

function sendIceCandidate(ws, sessionId, pluginHandle, candidate) {
  sendSignal(ws, {
    janus: "trickle",
    session_id: sessionId,
    handle_id: pluginHandle,
    candidate: candidate || { completed: true }
  });
}

async function signalTransaction(ws, messages, data) {
  var transactionId = sendSignal(ws, data);

  for await (let message of messages) {
    if (message.transaction && message.transaction === transactionId) {
      if (message.janus && message.janus === "success") {
        return message;
      } else {
        throw new Error(message.error);
      }
    }
  }
}

function waitForEvent(obj, event) {
  var resolveCallback;

  var promise = new Promise(resolve => {
    resolveCallback = resolve;
  });

  obj.addEventListener(event, e => resolveCallback(e), { once: true });

  return promise;
}

function wait(ms) {
  return new Promise(resolve => {
    setTimeout(_ => resolve(), ms);
  });
}

function makeWSMessageIterator(ws) {
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

    this.occupants = {};
    this.occupantSubscribers = {};
    this.occupantMediaStreams = {};

    this.sendKeepAliveMessage = this.sendKeepAliveMessage.bind(this);
    this.onDataChannelMessage = this.onDataChannelMessage.bind(this);
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
    this.janusServer.addEventListener("open", () =>
      this.setupRTCPeerConnection()
    );
  }

  async setupRTCPeerConnection() {
    var messages = makeWSMessageIterator(this.janusServer);

    // Create Janus session
    var sessionResponse = await signalTransaction(this.janusServer, messages, {
      janus: "create"
    });

    this.janusSessionId = sessionResponse.data.id;

    // Send keep alive messages now and then every 30 seconds.
    // TODO: only send keep alive messages after 30 seconds of inactivity.
    this.sendKeepAliveMessage();

    // Attach Reticulum Janus plugin.
    var pluginResponse = await signalTransaction(this.janusServer, messages, {
      janus: "attach",
      session_id: this.janusSessionId,
      plugin: "janus.plugin.retproxy",
      "force-bundle": true,
      "force-rtcp-mux": true
    });

    this.retproxyHandle = pluginResponse.data.id;

    // Create the RTCPeerConnection
    this.rtcPeer = new RTCPeerConnection(PEER_CONNECTION_CONFIG);

    this.rtcPeer.addEventListener("icecandidate", event =>
      sendIceCandidate(
        this.janusServer,
        this.janusSessionId,
        this.retproxyHandle,
        event.candidate
      )
    );

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

    var mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true
    });
    this.rtcPeer.addStream(mediaStream);

    // Create, set, and send the WebRTC offer.
    var offer = await this.rtcPeer.createOffer();
    await this.rtcPeer.setLocalDescription(offer);

    var publisherTransactionId = sendSignal(this.janusServer, {
      janus: "message",
      body: {
        kind: "join",
        role: "publisher"
      },
      session_id: this.janusSessionId,
      handle_id: this.retproxyHandle,
      jsep: offer
    });

    // Wait for multiple responses from the server
    for await (let message of messages) {
      if (
        message.transaction &&
        message.transaction === publisherTransactionId
      ) {
        // Set the remote description returned from Janus.
        if (message.jsep) {
          await this.rtcPeer.setRemoteDescription(message.jsep);
        } else if (
          message.plugindata &&
          message.plugindata.data &&
          message.plugindata.data.event &&
          message.plugindata.data.event === "join_self"
        ) {
          // Set the local clientId and current occupants in the room.
          this.clientId = message.plugindata.data.user_id;

          var occupantIds = message.plugindata.data.user_ids;
          for (occupantId of occupantIds) {
            if (occupantId !== this.clientId) {
              this.occupants[occupantId] = true;
            }
          }
        }

        // Continue when both messages have been processed.
        if (this.rtcPeer.remoteDescription && this.clientId) {
          break;
        }
      }
    }

    // Wait for the reliable channel to open before continuing.
    await waitForEvent(this.reliableChannel, "open");

    this.connectSuccess(this.clientId);

    for (var occupantId in this.occupants) {
      if (this.occupants.hasOwnProperty(occupantId)) {
        this.occupantMediaStreams[occupantId] = this.addSubscriber(occupantId);
        this.openListener(occupantId);
        console.log("setAudioStream", occupantId);
      }
    }

    this.occupantListener(this.occupants);

    // Handle leave and join events
    for await (let message of messages) {
      if (
        message.plugindata &&
        message.plugindata.data &&
        message.sender === this.retproxyHandle
      ) {
        var data = message.plugindata.data;

        if (data.event === "join_other") {
          if (!this.occupants[data.user_id]) {
            await wait(1000); // TODO: Actually fix this race condition.
            this.occupants[data.user_id] = true;
            this.occupantMediaStreams[data.user_id] = this.addSubscriber(
              data.user_id
            );
            console.log("setAudioStream", data.user_id);
            this.occupantListener(this.occupants);
            this.openListener(data.user_id);
          }
        } else if (data.event === "leave") {
          if (this.occupants[data.user_id]) {
            delete this.occupants[data.user_id];
            this.closedListener(data.user_id);
            this.occupantListener(this.occupants);
          }
        }
      }
    }
  }

  async addSubscriber(occupantId) {
    var messages = makeWSMessageIterator(this.janusServer);

    // Attach Reticulum Janus plugin.
    var pluginResponse = await signalTransaction(this.janusServer, messages, {
      janus: "attach",
      session_id: this.janusSessionId,
      plugin: "janus.plugin.retproxy",
      "force-bundle": true,
      "force-rtcp-mux": true
    });

    var pluginHandle = pluginResponse.data.id;

    var occupantPeer = new RTCPeerConnection(PEER_CONNECTION_CONFIG);

    this.occupantSubscribers[occupantId] = occupantPeer;

    occupantPeer.addEventListener("icecandidate", event =>
      sendIceCandidate(
        this.janusServer,
        this.janusSessionId,
        pluginHandle,
        event.candidate
      )
    );

    var occupantOffer = await occupantPeer.createOffer({
      offerToReceiveAudio: true
    });
    await occupantPeer.setLocalDescription(occupantOffer);

    var subscriberTransactionId = sendSignal(this.janusServer, {
      janus: "message",
      body: {
        kind: "join",
        role: "subscriber",
        user_id: this.clientId,
        target_id: occupantId
      },
      session_id: this.janusSessionId,
      handle_id: pluginHandle,
      jsep: occupantOffer
    });

    for await (let message of messages) {
      if (
        message.transaction &&
        message.transaction === subscriberTransactionId
      ) {
        // Set the remote description returned from Janus.
        if (message.jsep) {
          await occupantPeer.setRemoteDescription(message.jsep);

          var streams = occupantPeer.getRemoteStreams();

          if (streams.length > 0) {
            console.log(streams[0]);
            return streams[0];
          } else {
            throw new Error("No media streams received.");
          }
        }
      }
    }
  }

  sendKeepAliveMessage() {
    sendSignal(this.janusServer, {
      janus: "keepalive",
      session_id: this.janusSessionId
    });

    this.keepAliveTimeout = setTimeout(
      () => this.sendKeepAliveMessage(),
      30000
    );
  }

  onDataChannelMessage(event) {
    var message = JSON.parse(event.data);
    console.log("Received message:", message.transaction, message);

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
    if (this.occupants[clientId]) {
      return INetworkAdapter.IS_CONNECTED;
    } else {
      return INetworkAdapter.NOT_CONNECTED;
    }
  }

  getAudioStream(clientId) {
    console.log("getAudioStream", clientId);

    return (
      this.occupantMediaStreams[clientId] || Promise.reject("No audio stream.")
    );
  }

  enableMicrophone(enabled) {
    this.notImplemented("enableMicrophone");
  }

  sendData(clientId, dataType, data) {
    var message = { clientId, dataType, data };
    // console.log("sendData", message);
    this.unreliableChannel.send(JSON.stringify(message));
  }

  sendDataGuaranteed(clientId, dataType, data) {
    var message = { clientId, dataType, data };
    // console.log("sendDataGuaranteed", message);
    this.reliableChannel.send(JSON.stringify(message));
  }

  broadcastData(dataType, data) {
    var message = { dataType, data };
    // console.log("broadcastData", message);
    this.unreliableChannel.send(JSON.stringify(message));
  }

  broadcastDataGuaranteed(dataType, data) {
    var message = { dataType, data, transaction: randomString(3) };
    // console.log("broadcastDataGuaranteed:", message.transaction, message);
    this.reliableChannel.send(JSON.stringify(message));
  }
}

module.exports = JanusAdapter;
