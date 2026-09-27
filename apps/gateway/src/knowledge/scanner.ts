import { connect } from 'node:net';

export type ScanVerdict =
  | { clean: true; engine: string }
  | { clean: false; engine: string; reason: 'malware' | 'scan_unavailable'; signature?: string };

/** Malware scanning for uploads. Any failure to scan is a rejection (fail closed). */
export interface Scanner {
  scan(bytes: Uint8Array): Promise<ScanVerdict>;
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Development scanner: detects only the EICAR test file. Production sets CLAMAV_URL so uploads
 * go through ClamAV.
 */
export class EicarScanner implements Scanner {
  async scan(bytes: Uint8Array): Promise<ScanVerdict> {
    const text = Buffer.from(bytes).toString('latin1');
    return text.includes(EICAR)
      ? { clean: false, engine: 'eicar', reason: 'malware', signature: 'Eicar-Test-Signature' }
      : { clean: true, engine: 'eicar' };
  }
}

/** ClamAV over the clamd INSTREAM protocol (tcp://host:3310). */
export class ClamdScanner implements Scanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 30_000,
  ) {}

  scan(bytes: Uint8Array): Promise<ScanVerdict> {
    return new Promise((resolve) => {
      const unavailable = () =>
        resolve({ clean: false, engine: 'clamav', reason: 'scan_unavailable' });
      const socket = connect({ host: this.host, port: this.port });
      const replies: Buffer[] = [];
      socket.setTimeout(this.timeoutMs, () => {
        socket.destroy();
        unavailable();
      });
      socket.on('error', unavailable);
      socket.on('data', (data) => replies.push(data));
      socket.on('end', () => {
        const reply = Buffer.concat(replies).toString('utf8').replace(/\0/g, '').trim();
        if (/: OK$/.test(reply)) resolve({ clean: true, engine: 'clamav' });
        else if (/FOUND$/.test(reply)) {
          resolve({
            clean: false,
            engine: 'clamav',
            reason: 'malware',
            signature: reply.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, ''),
          });
        } else unavailable();
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        const size = 64 * 1024;
        for (let offset = 0; offset < bytes.length; offset += size) {
          const piece = bytes.subarray(offset, offset + size);
          const length = Buffer.alloc(4);
          length.writeUInt32BE(piece.length);
          socket.write(length);
          socket.write(piece);
        }
        socket.end(Buffer.alloc(4));
      });
    });
  }
}

/** ClamAV when CLAMAV_URL (tcp://host:port) is set, otherwise the development EICAR check. */
export function scannerFromUrl(url: string | undefined): Scanner {
  if (!url) return new EicarScanner();
  const parsed = new URL(url);
  return new ClamdScanner(parsed.hostname, Number(parsed.port || 3310));
}
