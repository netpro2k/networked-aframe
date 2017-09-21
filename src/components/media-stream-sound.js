const queryString = require('query-string');
const qs = queryString.parse(location.search)

// import { Vector3 } from '../math/Vector3';
// import { Quaternion } from '../math/Quaternion';
// import { Object3D } from '../core/Object3D';
// import { AudioContext } from './AudioContext';
const Vector3 = THREE.Vector3;
const Quaternion = THREE.Quaternion;
const Object3D = THREE.Object3D;
const AudioContext = THREE.AudioContext;
const { Songbird } = require('songbird-audio');

function SongbirdAudioListener() {

    Object3D.call( this );

    this.type = 'SongbirdAudioListener';

    this.context = AudioContext.getContext();
    this.songbird = new Songbird(this.context, {
        ambisonicOrder: qs.ambisonicOrder && parseInt(qs.ambisonicOrder) || 1
			  // dimensions: { width: 10, height: 5, depth: 10 },
			  // materials: {left: 'brick-bare', right: 'brick-bare', down: 'brick-bare',
				//             up: 'brick-bare', front: 'brick-bare', back: 'brick-bare'}
    });

    this.songbird.output.connect(this.context.destination);
}

SongbirdAudioListener.prototype = Object.assign( Object.create( Object3D.prototype ), {

    constructor: SongbirdAudioListener,

    getMasterVolume: function () {
        return this.songbird.output.gain.value;
    },

    setMasterVolume: function ( value ) {
        this.songbird.output.gain.value = value;
    },

    updateMatrixWorld: function (force) {
        Object3D.prototype.updateMatrixWorld.call( this, force );
        this.songbird.setListenerFromMatrix(this.matrixWorld);
	  }
});


function SongbirdPositionalAudio( listener ) {

    Object3D.call( this );

    this.type = 'SongbirdPositionalAudio';

    this.songbirdSource = listener.songbird.createSource({
        minDistance: 0.5
    });
}

SongbirdPositionalAudio.prototype = Object.assign( Object.create( Object3D.prototype ), {

    constructor: SongbirdPositionalAudio,

	  setNodeSource: function ( audioNode ) {
		    this.hasPlaybackControl = false;
		    this.sourceType = 'audioNode';
		    this.source = audioNode;
		    this.connect();
		    return this;
	  },

    connect() {
        this.source.connect(this.songbirdSource.input);
		    return this;
    },

    disconnect() {
        this.source.disconnect(this.songbirdSource.input);
		    return this;
    },

    getRefDistance: function () {

        return this.panner.refDistance;

    },

    setRefDistance: function ( value ) {

        this.panner.refDistance = value;

    },

    getRolloffFactor: function () {

        return this.panner.rolloffFactor;

    },

    setRolloffFactor: function ( value ) {

        this.panner.rolloffFactor = value;

    },

    getDistanceModel: function () {

        return this.panner.distanceModel;

    },

    setDistanceModel: function ( value ) {

        this.panner.distanceModel = value;

    },

    getMaxDistance: function () {

        return this.panner.maxDistance;

    },

    setMaxDistance: function ( value ) {

        this.panner.maxDistance = value;

    },

    updateMatrixWorld: function (force) {
        Object3D.prototype.updateMatrixWorld.call( this, force );
        this.songbirdSource.setFromMatrix(this.matrixWorld);
    }
} );









var naf = require('../NafIndex');

// largely duplicate of a-sound
AFRAME.registerComponent('media-stream-sound', {
    schema: {
        distanceModel: {default: 'inverse',
                        oneOf: ['linear', 'inverse', 'exponential']},
        maxDistance: {default: 10000},
        positional: {default: true},
        refDistance: {default: 1},
        rolloffFactor: {default: 1},
        volume: {default: 1},
        mediaStream: {default: null}
    },

    init: function () {
        this.listener = null;
        this.setupSound();
    },

    update: function (oldData) {
        var data = this.data;
        if(data.mediaStream != oldData.mediaStream) {
            if(oldData.mediaStream) {
                this.sound.disconnect();
            }
            if(data.mediaStream) {
                var source = this.listener.context.createMediaStreamSource(data.mediaStream);
                this.sound.setNodeSource(source);
            }
        }
    },

    remove: function () {
        this.el.removeObject3D(this.attrName);
        this.sound.disconnect();
    },

    /**
     * Removes current sound object, creates new sound object, adds to entity.
     *
     * @returns {object} sound
     */
    setupSound: function () {
        var el = this.el;
        var sceneEl = el.sceneEl;

        if (this.sound) {
            el.removeObject3D('sound');
        }

        const useSongbird = !qs.songbird || qs.songbird.toLowerCase() === "true";
        console.log("Use songbird?", useSongbird);

        const Listener = useSongbird ? SongbirdAudioListener : THREE.AudioListener;
        const Audio = useSongbird ? SongbirdPositionalAudio : THREE.PositionalAudio;

        // Only want one AudioListener. Cache it on the scene.
        var listener = this.listener = sceneEl.audioListener || new Listener();
        sceneEl.audioListener = listener;

        if (sceneEl.camera) {
            sceneEl.camera.add(listener);
        }

        // Wait for camera if necessary.
        sceneEl.addEventListener('camera-set-active', function (evt) {
            evt.detail.cameraEl.getObject3D('camera').add(listener);
        });

        var data = this.data;
        var sound = new Audio(listener);
        // sound.setDistanceModel(data.distanceModel);
        // sound.setMaxDistance(data.maxDistance);
        // sound.setRefDistance(data.refDistance);
        // sound.setRolloffFactor(data.rolloffFactor);
        // sound.setVolume(data.volume);

        this.sound = sound;
        el.setObject3D(this.attrName, this.sound);
    }
});
