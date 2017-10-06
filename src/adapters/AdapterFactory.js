var WsEasyRtcAdapter = require("../adapters/WsEasyRtcAdapter");
var EasyRtcAdapter = require("../adapters/EasyRtcAdapter");
var UwsAdapter = require("../adapters/UwsAdapter");
var FirebaseWebRtcAdapter = require("../adapters/FirebaseWebRtcAdapter");
var JanusAdapter = require("../adapters/JanusAdapter");

class AdapterFactory {
  make(adapterName) {
    var adapter;
    switch (adapterName.toLowerCase()) {
      case "uws":
        adapter = new UwsAdapter();
        break;
      case "firebase":
        adapter = new FirebaseWebRtcAdapter(
          window.firebase,
          window.firebaseConfig
        );
        break;
      case "easyrtc":
        adapter = new EasyRtcAdapter(window.easyrtc);
        break;
      case "janus":
        adapter = new JanusAdapter();
        break;
      case "wseasyrtc":
      default:
        adapter = new WsEasyRtcAdapter(window.easyrtc);
        break;
    }
    return adapter;
  }
}

var adapterFactory = new AdapterFactory();

module.exports = adapterFactory;
