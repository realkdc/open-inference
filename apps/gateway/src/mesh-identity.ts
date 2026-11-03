import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';

const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * MeshLLM's Node SDK owner keypair is 32 signing-seed bytes followed by 32
 * encryption-seed bytes. MeshLLM owner IDs are SHA-256 of the Ed25519 public
 * key. This keeps the gateway's stable public owner ID available to hosts
 * without exposing the private keypair.
 */
export function meshOwnerIdFromKeypairHex(keypairHex: string): string {
  if (!/^[a-f0-9]{128}$/i.test(keypairHex)) {
    throw new Error('MeshLLM owner keypair must contain exactly 64 bytes of hex data.');
  }

  const signingSeed = Buffer.from(keypairHex.slice(0, 64), 'hex');
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, signingSeed]),
    format: 'der',
    type: 'pkcs8'
  });
  const signingPublicKey = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32);

  return createHash('sha256').update(signingPublicKey).digest('hex');
}
