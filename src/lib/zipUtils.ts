import * as archiver from "archiver";
/**
 * Zips directory to base64 string.
 *
 * https://github.com/archiverjs/node-archiver
 *
 * @param dir to zip
 * @param options
 * @returns base64 encoded zip data
 */
export function zipDirToBase64(dir, options = {}): Promise<string> {
  const zOptions = Object.assign({ level: 9 }, options);
  const bufs = [];
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", zOptions);
    archive.on("finish", () => {
      //   logger.debug(
      //     `${archive.pointer()} bytes written to ${outFile} using ${this.getElapsedTime(
      //       timer
      //     )}ms`
      //   );
      // zip file returned once stream is closed, see 'close' listener below
      //   console.log("Buffer:", bufs);
      const buf = Buffer.concat(bufs);
      const base64Data = buf.toString("base64"); // bufs.toString("base64");      console.log("Base 64 data:", base64Data);
      resolve(base64Data);
    });
    archive.on("error", err => {
      reject(err);
    });

    archive.on("data", d => {
      bufs.push(d);
    });

    archive.directory(dir, "");
    archive.finalize();
  });
}
