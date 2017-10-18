var INetworkAdapter = require("./INetworkAdapter");

const ContentKind = {
  Audio: 1,
  Video: 2,
  Data: 4
};

const ContentKindNames = {
  1: "Audio",
  2: "Video",
  4: "Data"
};

var charSet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomString(len) {
  var str = "";

  for (var i = 0; i < len; i++) {
    var pos = Math.floor(Math.random() * charSet.length);
    str += charSet.substring(pos, pos + 1);
  }

  return str;
}

function waitForEvent(target, event) {
  return new Promise((resolve, reject) => {
    target.addEventListener(event, e => resolve(e), { once: true });
  });
}

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

class JanusAdapter extends INetworkAdapter {
  constructor() {
    super();

    this.app = "default";
    this.room = 1;
    this.serverUrl = null;

    this.ws = null;
    this.messageHandlers = [];
    this.onWebsocketMessage = this.onWebsocketMessage.bind(this);

    this.occupants = {};
    this.occupantMediaStreams = {};
    this.onDataChannelMessage = this.onDataChannelMessage.bind(this);
  }

  setServerUrl(url) {
    this.serverUrl = url;
  }

  setApp(app) {
    this.app = app;
  }

  setRoom(roomName) {
    // this.room = roomName;
  }

  setWebRtcOptions(options) {}

  setServerConnectListeners(successListener, failureListener) {
    this.connectSuccess = successListener;
    this.connectFailure = failureListener;
  }

  setRoomOccupantListener(occupantListener) {
    this.onOccupantsChanged = occupantListener;
  }

  setDataChannelListeners(openListener, closedListener, messageListener) {
    this.onOccupantConnected = openListener;
    this.onOccupantDisconnected = closedListener;
    this.onOccupantMessage = messageListener;
  }

  connect() {
    this.ws = new WebSocket(this.serverUrl, "janus-protocol");
    this.ws.addEventListener("open", _ => this.onWebsocketOpen());
    this.ws.addEventListener("message", this.onWebsocketMessage);
  }

  async onWebsocketOpen() {
    // Create the Janus Session
    this.sessionId = await this.sendCreateSession();

    // Attach the SFU Plugin and create a RTCPeerConnection for the publisher.
    // The publisher sends audio and opens two bidirectional data channels.
    // One reliable datachannel and one unreliable.
    var publisher = await this.createPublisher();
    this.publisher = publisher;

    // Start listening for join and leave events from the publisher.
    // Queue these events so we can handle them as soon as the reliable datachannel is open.
    var publisherEvents = this.messageIterator(
      msg =>
        msg.janus &&
        msg.janus === "event" &&
        msg.sender &&
        msg.sender === publisher.handleId
    );

    // Wait for the reliable datachannel to be open before we start sending messages on it.
    await waitForEvent(publisher.reliableChannel, "open");
    // DEBUG
    console.log("Reliable datachannel opened");

    this.userId = publisher.userId;
    this.connectSuccess(publisher.userId);

    // Add all of the initial occupants.
    for (let occupantId of publisher.initialOccupants) {
      if (occupantId !== publisher.userId) {
        // DEBUG
        console.log("add initial occupant", { userId: occupantId });
        this.addOccupant(publisher.handleId, occupantId);
      }
    }

    // Handle all of the join and leave events from the publisher.
    for await (let message of publisherEvents) {
      var data = message.plugindata.data;

      if (data.event && data.event === "join") {
        // DEBUG
        console.log("onJoin", { userId: data.user_id });
        this.addOccupant(publisher.handleId, data.user_id);
      } else if (data.event && data.event === "leave") {
        // DEBUG
        console.log("onLeave", { userId: data.user_id });
        this.removeOccupant(data.user_id);
      }
    }
  }

  async addOccupant(publisherHandle, occupantId) {
    var subscriber = await this.createSubscriber(publisherHandle, occupantId);
    this.occupantMediaStreams[occupantId] = subscriber.mediaStream;
    // Call the Networked AFrame callbacks for the new occupant.
    this.onOccupantConnected(occupantId);
    this.occupants[occupantId] = true;
    this.onOccupantsChanged(this.occupants);
  }

  removeOccupant(occupantId) {
    if (this.occupants[occupantId]) {
      delete this.occupants[occupantId];
      // Call the Networked AFrame callbacks for the removed occupant.
      this.onOccupantDisconnected(occupantId);
      this.onOccupantsChanged(this.occupants);
    }
  }

  async createPublisher() {
    var handleId = await this.sendAttachSFUPlugin();

    var peerConnection = new RTCPeerConnection(PEER_CONNECTION_CONFIG);

    peerConnection.addEventListener("icecandidate", event =>
      this.sendIceCandidate(handleId, event.candidate)
    );

    // Create an unreliable datachannel for sending and receiving component updates, etc.
    var unreliableChannel = peerConnection.createDataChannel("unreliable", {
      ordered: false,
      maxRetransmits: 0
    });

    // Create a reliable datachannel for sending and recieving entity instantiations, etc.
    var reliableChannel = peerConnection.createDataChannel("reliable", {
      ordered: true
    });

    unreliableChannel.addEventListener("message", this.onDataChannelMessage);

    reliableChannel.addEventListener("message", this.onDataChannelMessage);

    // Add your microphone's stream to the PeerConnection.
    var mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true
    });

    peerConnection.addStream(mediaStream);

    var offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    var userId;
    var initialOccupants = [];

    // Handle each event associated with the publisher.
    for await (let message of this.sendJoin(handleId, offer)) {
      if (message.jsep) {
        // DEBUG
        console.log("createPublisher received: jsep");
        await peerConnection.setRemoteDescription(message.jsep);
      } else if (
        // TODO: Can we flatten this data structure?
        // TODO: Can we use an initial event type?
        message.plugindata &&
        message.plugindata.data &&
        message.plugindata.data.response
      ) {
        var response = message.plugindata.data.response;
        // DEBUG
        console.log("createPublisher received:", response);
        userId = response.user_id;
        initialOccupants = response.user_ids;
      }

      if (peerConnection.remoteDescription && userId) {
        break;
      }
    }

    return {
      handleId,
      userId,
      initialOccupants,
      reliableChannel,
      unreliableChannel,
      mediaStream,
      peerConnection
    };
  }

  async createSubscriber(publisherHandle, occupantId) {
    // Start receiving data for this occupant on the publicher peer connection.
    await this.subscribeTo(publisherHandle, occupantId, ContentKind.Data);

    var handleId = await this.sendAttachSFUPlugin();

    var peerConnection = new RTCPeerConnection(PEER_CONNECTION_CONFIG);

    peerConnection.addEventListener("icecandidate", event =>
      this.sendIceCandidate(handleId, event.candidate)
    );

    var offer = await peerConnection.createOffer({
      offerToReceiveAudio: true
    });

    await peerConnection.setLocalDescription(offer);

    for await (let response of this.sendJoin(handleId, offer)) {
      if (response.jsep) {
        // DEBUG
        console.log("createSubscriber received: jsep");
        await peerConnection.setRemoteDescription(response.jsep);
        break;
      }
    }

    // Get the occupant's audio stream.
    var streams = peerConnection.getRemoteStreams();
    var mediaStream = streams.length > 0 ? streams[0] : null;

    // Start receiving audio for this occupant on this peer connection.
    await this.subscribeTo(handleId, occupantId, ContentKind.Audio);

    return {
      handleId,
      mediaStream,
      peerConnection
    };
  }

  async sendCreateSession() {
    // DEBUG
    console.log("sendCreateSession");
    var response = await this.transactionPromise({ janus: "create" });
    return response.data.id;
  }

  async sendAttachSFUPlugin() {
    // DEBUG
    console.log("sendAttachSFUPlugin");

    var response = await this.transactionPromise({
      janus: "attach",
      session_id: this.sessionId,
      plugin: "janus.plugin.sfu",
      "force-bundle": true,
      "force-rtcp-mux": true
    });

    return response.data.id;
  }

  sendJoin(handleId, offer) {
    // DEBUG
    console.log("sendJoin", {
      handleId,
      userId: this.userId,
      roomId: this.room
    });

    var signal = {
      janus: "message",
      body: {
        kind: "join",
        room_id: this.room
      },
      session_id: this.sessionId,
      handle_id: handleId,
      jsep: offer
    };

    if (this.userId) {
      signal.body.user_id = this.userId;
    }

    return this.transactionIterator(signal);
  }

  sendIceCandidate(handleId, candidate) {
    return this.sendSignal({
      janus: "trickle",
      session_id: this.sessionId,
      handle_id: handleId,
      candidate: candidate || { completed: true }
    });
  }

  sendKeepAliveMessage() {
    // Send a keepalive message to keep the WebRTC connections from closing.
    return this.sendSignal({
      janus: "keepalive",
      session_id: this.sessionId
    });
  }

  async sendSubscribe(handleId, specs) {
    var signal = {
      janus: "message",
      body: {
        kind: "subscribe",
        specs
      },
      session_id: this.sessionId,
      handle_id: handleId
    };

    for await (let message of this.transactionIterator(signal)) {
      if (message.janus === "event") {
        var success = message.plugindata.data.success;
        if (success) {
          return message;
        } else {
          throw new Error(message);
        }
      }
    }
  }

  subscribeTo(handleId, userId, contentKind) {
    // DEBUG
    console.log("subscribeTo", {
      userId,
      contentKind: ContentKindNames[contentKind]
    });
    return this.sendSubscribe(handleId, [
      {
        publisher_id: userId,
        content_kind: contentKind
      }
    ]);
  }

  subscribeToAll(handleId, userIds, contentKind) {
    // DEBUG
    console.log("subscribeToAll", {
      userIds,
      contentKind: ContentKindNames[contentKind]
    });

    var specs = userIds.map(userId => ({
      publisher_id: userId,
      content_kind: contentKind
    }));

    return this.sendSubscribe(handleId, specs);
  }

  transactionPromise(message) {
    var transactionId = this.sendSignal(message);
    return this.messagePromise(
      message => message.transaction && message.transaction === transactionId
    );
  }

  transactionIterator(message) {
    var transactionId = this.sendSignal(message);
    return this.messageIterator(
      message => message.transaction && message.transaction === transactionId
    );
  }

  // Attach a random transaction id to the message and send.
  sendSignal(message) {
    var transactionId = randomString(12);
    message.transaction = transactionId;
    //console.log("Websocket Sent:", message);
    this.ws.send(JSON.stringify(message));
    clearTimeout(this.keepAliveTimeout);
    this.keepAliveTimeout = setTimeout(
      () => this.sendKeepAliveMessage(),
      30000
    );
    return transactionId;
  }

  messagePromise(filter) {
    return new Promise((resolve, reject) => {
      this.messageHandlers.push({
        type: "promise",
        filter,
        resolve,
        reject
      });
    });
  }

  messageIterator(filter) {
    var self = this;

    var messageHandler = {
      type: "iterator",
      filter,
      messages: [],
      error: null,
      resolve: null,
      reject: null
    };

    this.messageHandlers.push(messageHandler);

    var iterator = {
      next() {
        // Handle any error responses.
        if (messageHandler.error) {
          return Promise.reject(messageHandler.error);
        }

        // If the handler already has messages queued, use those.
        if (messageHandler.messages.length > 0) {
          return Promise.resolve({
            value: messageHandler.messages.shift()
          });
        }

        // Otherwise add a new promise to the handler so we can wait for the next message.
        return new Promise((resolve, reject) => {
          messageHandler.resolve = resolve;
          messageHandler.reject = reject;
        });
      },
      return() {
        var idx = self.messageHandlers.indexOf(messageHandler);
        self.messageHandlers.splice(idx, 1);
        return Promise.resolve({ done: true });
      },
      [Symbol.asyncIterator]() {
        return iterator;
      }
    };

    return iterator;
  }

  // Process all incoming websocket messages. Resolve, queue, and handle errors.
  onWebsocketMessage(event) {
    var message = JSON.parse(event.data);
    //console.log("Websocket Received:", message);

    for (var handler of this.messageHandlers) {
      if (handler.filter(message)) {
        if (handler.type === "promise") {
          if (message.janus === "success") {
            handler.resolve(message);
          } else {
            handler.reject(message);
          }
        } else if (handler.type === "iterator") {
          if (message.error) {
            if (handler.reject) {
              handler.reject(message);
            } else {
              handler.error = message;
            }
          } else {
            if (handler.resolve) {
              handler.resolve({ value: message });
            } else {
              handler.messages.push(message);
            }
          }
        }
      }
    }
  }

  onDataChannelMessage(event) {
    var message = JSON.parse(event.data);
    // console.log("Received message:", message.transaction, message);

    if (message.dataType) {
      this.onOccupantMessage(null, message.dataType, message.data);
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
    console.log("getAudioStream", clientId, this.occupantMediaStreams);
    return (
      Promise.resolve(this.occupantMediaStreams[clientId]) ||
      Promise.reject(`No media stream for client: ${clientId}`)
    );
  }

  enableMicrophone(enabled) {
    this.notImplemented("enableMicrophone");
  }

  sendData(clientId, dataType, data) {
    // console.log("sendData", data);
    this.publisher.unreliableChannel.send(
      JSON.stringify({ clientId, dataType, data })
    );
  }

  sendDataGuaranteed(clientId, dataType, data) {
    // console.log("sendDataGuaranteed", data);
    this.publisher.reliableChannel.send(
      JSON.stringify({ clientId, dataType, data })
    );
  }

  broadcastData(dataType, data) {
    // console.log("broadcastData", data);
    this.publisher.unreliableChannel.send(JSON.stringify({ dataType, data }));
  }

  broadcastDataGuaranteed(dataType, data) {
    console.log("broadcastDataGuaranteed", data);
    this.publisher.reliableChannel.send(JSON.stringify({ dataType, data }));
  }
}

module.exports = JanusAdapter;
