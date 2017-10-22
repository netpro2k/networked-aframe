var mj = require("minijanus");

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
    this.session = null;
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
    this.session = new mj.JanusSession(this.ws.send.bind(this.ws));
    this.ws.addEventListener("open", _ => this.onWebsocketOpen());
    this.ws.addEventListener("message", this.onWebsocketMessage);
  }

  async onWebsocketOpen() {
    // Create the Janus Session
    await this.session.create();

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
        msg.sender === publisher.handle.id
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
        this.addOccupant(occupantId);
      }
    }

    // Handle all of the join and leave events from the publisher.
    for await (let message of publisherEvents) {
      var data = message.plugindata.data;

      if (data.event && data.event === "join") {
        // DEBUG
        console.log("onJoin", { userId: data.user_id });
        this.addOccupant(data.user_id);
      } else if (data.event && data.event === "leave") {
        // DEBUG
        console.log("onLeave", { userId: data.user_id });
        this.removeOccupant(data.user_id);
      }
    }
  }

  async addOccupant(occupantId) {
    var subscriber = await this.createSubscriber(occupantId);
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
    var handle = new mj.JanusPluginHandle(this.session);
    await handle.attach("janus.plugin.sfu");

    var peerConnection = new RTCPeerConnection(PEER_CONNECTION_CONFIG);

    peerConnection.addEventListener("icecandidate", event => {
      handle.sendTrickle(event.candidate);
    });

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

    var offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    var userId;
    var initialOccupants = [];

    var answer = await handle.sendJsep(offer);
    await peerConnection.setRemoteDescription(answer.jsep);

    var message = await this.sendJoin(handle, this.room);
    if (
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

    return {
      handle,
      userId,
      initialOccupants,
      reliableChannel,
      unreliableChannel,
      peerConnection
    };
  }

  async createSubscriber(occupantId) {
    var handle = new mj.JanusPluginHandle(this.session);
    await handle.attach("janus.plugin.sfu");

    var peerConnection = new RTCPeerConnection(PEER_CONNECTION_CONFIG);

    peerConnection.addEventListener("icecandidate", event => {
      handle.sendTrickle(event.candidate);
    });

    var offer = await peerConnection.createOffer({
      offerToReceiveAudio: true
    });

    await peerConnection.setLocalDescription(offer);
    var answer = await handle.sendJsep(offer);
    await peerConnection.setRemoteDescription(answer.jsep);

    await this.sendJoin(handle, this.room, this.userId, [{
      publisher_id: occupantId,
      content_kind: ContentKind.Audio
    }]);

    // Get the occupant's audio stream.
    var streams = peerConnection.getRemoteStreams();
    var mediaStream = streams.length > 0 ? streams[0] : null;

    return {
      handle,
      mediaStream,
      peerConnection
    };
  }

  sendJoin(handle, roomId, userId, specs) {
    var signal = { kind: "join", room_id: roomId, user_id: userId, subscription_specs: specs };
    return handle.sendMessage(signal);
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
    this.session.receive(message);
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
