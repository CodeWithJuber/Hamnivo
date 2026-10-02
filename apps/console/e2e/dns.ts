/**
 * A tiny DNS server for the domain-verification step of single sign-on (A13): it answers TXT
 * questions from a JSON file the tests write ({"name": ["value", …]}) and says "no such name"
 * otherwise. The gateway uses it through SSO_DNS_SERVERS. Plain erasable TypeScript.
 */
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';

const TXT = 16;

function readName(message: Buffer, offset: number): { name: string; end: number } {
  const labels: string[] = [];
  let at = offset;
  for (;;) {
    const length = message[at];
    if (length === undefined) throw new Error('truncated name');
    if (length === 0) break;
    labels.push(message.toString('ascii', at + 1, at + 1 + length));
    at += length + 1;
  }
  return { name: labels.join('.').toLowerCase(), end: at + 1 };
}

function records(file: string): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string[]>;
  } catch {
    return {};
  }
}

function answer(query: Buffer, file: string): Buffer | null {
  if (query.length < 12 || query.readUInt16BE(4) !== 1) return null;
  const { name, end } = readName(query, 12);
  const type = query.readUInt16BE(end);
  const question = query.subarray(12, end + 4);
  const values = type === TXT ? records(file)[name] : undefined;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  // Response, authoritative, recursion flags echoed; NXDOMAIN when the name is unknown.
  const recursion = query.readUInt16BE(2) & 0x0100;
  header.writeUInt16BE(0x8000 | 0x0400 | recursion | 0x0080 | (values ? 0 : 3), 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(values?.length ?? 0, 6);
  const answers = (values ?? []).map((value) => {
    const text = Buffer.from(value, 'utf8');
    const strings: Buffer[] = [];
    for (let i = 0; i < text.length; i += 255) {
      const part = text.subarray(i, i + 255);
      strings.push(Buffer.from([part.length]), part);
    }
    const data = Buffer.concat(strings);
    const record = Buffer.alloc(12);
    record.writeUInt16BE(0xc00c, 0); // the name in the question
    record.writeUInt16BE(TXT, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(1, 6);
    record.writeUInt16BE(data.length, 10);
    return Buffer.concat([record, data]);
  });
  return Buffer.concat([header, question, ...answers]);
}

export async function startDnsServer(port: number, file: string): Promise<() => Promise<void>> {
  const socket = createSocket('udp4');
  socket.on('message', (query, remote) => {
    try {
      const reply = answer(query, file);
      if (reply) socket.send(reply, remote.port, remote.address);
    } catch {
      // A malformed question gets no answer.
    }
  });
  await new Promise<void>((resolve) => socket.bind(port, '127.0.0.1', () => resolve()));
  return () => new Promise<void>((resolve) => socket.close(() => resolve()));
}
