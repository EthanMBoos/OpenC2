const path = require('path');

module.exports = {
  mode: 'development',
  target: 'web',  // Changed from 'electron-renderer' since contextIsolation is enabled
  entry: './src/renderer/renderer.js',
  output: {
    filename: 'renderer.bundle.js',
    path: path.resolve(__dirname, 'dist')
  },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      }
    ]
  },
  resolve: {
    extensions: ['.js', '.json']
  },
  devtool: 'source-map'
};
