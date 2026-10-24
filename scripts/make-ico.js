// assets/icon.png (256x256) を Windows 用の .ico に変換する。
// Vista 以降の .ico は中に PNG をそのまま格納できるため、変換ライブラリは不要。
const fs = require('fs');
const path = require('path');

const pngPath = path.join(__dirname, '..', 'assets', 'icon.png');
const icoPath = path.join(__dirname, '..', 'assets', 'icon.ico');
const png = fs.readFileSync(pngPath);

// ICONDIR (6 バイト) + ICONDIRENTRY (16 バイト) x 1
const header = Buffer.alloc(6 + 16);
header.writeUInt16LE(0, 0);      // reserved
header.writeUInt16LE(1, 2);      // type = icon
header.writeUInt16LE(1, 4);      // 格納する画像数

header.writeUInt8(0, 6);         // width  (0 = 256px)
header.writeUInt8(0, 7);         // height (0 = 256px)
header.writeUInt8(0, 8);         // パレット数 (フルカラーなので 0)
header.writeUInt8(0, 9);         // reserved
header.writeUInt16LE(1, 10);     // カラープレーン数
header.writeUInt16LE(32, 12);    // 1 ピクセルあたりのビット数
header.writeUInt32LE(png.length, 14); // 画像データのバイト数
header.writeUInt32LE(header.length, 18); // 画像データの開始位置

fs.writeFileSync(icoPath, Buffer.concat([header, png]));
console.log('wrote', icoPath);
