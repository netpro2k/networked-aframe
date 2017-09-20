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

        // Only want one AudioListener. Cache it on the scene.
        var listener = this.listener = sceneEl.audioListener || new THREE.AudioListener();
        sceneEl.audioListener = listener;

        if (sceneEl.camera) {
            sceneEl.camera.add(listener);
        }

        // Wait for camera if necessary.
        sceneEl.addEventListener('camera-set-active', function (evt) {
            evt.detail.cameraEl.getObject3D('camera').add(listener);
        });

        var data = this.data;
        var sound = data.positional ? new THREE.PositionalAudio(listener) : new THREE.Audio(listener);
        sound.setDistanceModel(data.distanceModel);
        sound.setMaxDistance(data.maxDistance);
        sound.setRefDistance(data.refDistance);
        sound.setRolloffFactor(data.rolloffFactor);
        sound.setVolume(data.volume);

        this.sound = sound;
        el.setObject3D(this.attrName, this.sound);
    }
});
