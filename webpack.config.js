module.exports = {
  entry: ["babel-polyfill", "./src/index.js"],
  output: {
    path: __dirname,
    filename: "./dist/networked-aframe.js"
  },
  module: {
    rules: [{ test: /\.js$/, exclude: /node_modules/, loader: "babel-loader" }]
  },
  devtool: "inline-source-map"
};
