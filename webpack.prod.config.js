module.exports = {
  entry: ["babel-polyfill", "./src/index.js"],
  output: {
    path: __dirname,
    filename: "./dist/networked-aframe.min.js"
  },
  module: {
    rules: [{ test: /\.js$/, exclude: /node_modules/, loader: "babel-loader" }]
  }
};
