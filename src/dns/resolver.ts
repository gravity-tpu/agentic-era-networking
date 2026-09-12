/**
 * resolver.ts
 * Fail-Closed DNS resolution engine foundation.
 *
 * Invariant:
 * - Unrecognized hostnames or expired TTLs without reachable authoritative servers
 *   must fail closed (return NXDOMAIN or throw ResolutionError).
 * - No silent fallback to unauthenticated plaintext upstreams.
 */

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT';

export interface DnsRecord {
  readonly name: string;
  readonly type: DnsRecordType;
  readonly value: string;
  readonly ttlSeconds: number;
  readonly createdAtNs: bigint;
}

export class DnsResolutionError extends Error {
  constructor(public readonly hostname: string, public readonly reason: string) {
    super(`DNS Resolution Failed for '${hostname}': ${reason}`);
    this.name = 'DnsResolutionError';
  }
}

export class FailClosedDnsResolver {
  private readonly zoneRecords: Map<string, DnsRecord[]> = new Map();

  constructor(private readonly defaultTtlSeconds: number = 300) {}

  /**
   * Registers an authoritative DNS record in the local zone.
   */
  public registerRecord(name: string, type: DnsRecordType, value: string, ttlSeconds: number = this.defaultTtlSeconds): void {
    const normalizedName = this.normalizeHostname(name);
    const existing = this.zoneRecords.get(normalizedName) ?? [];
    existing.push({
      name: normalizedName,
      type,
      value,
      ttlSeconds,
      createdAtNs: process.hrtime.bigint(),
    });
    this.zoneRecords.set(normalizedName, existing);
  }

  /**
   * Resolves a hostname for a specific record type.
   * Fail-closed invariant: If no active record exists, throws DnsResolutionError.
   */
  public resolve(name: string, type: DnsRecordType): DnsRecord {
    const normalizedName = this.normalizeHostname(name);
    const records = this.zoneRecords.get(normalizedName);

    if (!records || records.length === 0) {
      throw new DnsResolutionError(normalizedName, 'NXDOMAIN (Name does not exist in authoritative zone)');
    }

    const match = records.find(r => r.type === type);
    if (!match) {
      throw new DnsResolutionError(normalizedName, `NODATA (No record of type ${type} found for name)`);
    }

    // Check TTL expiration
    const nowNs = process.hrtime.bigint();
    const ageSeconds = Number((nowNs - match.createdAtNs) / 1_000_000_000n);
    if (ageSeconds > match.ttlSeconds) {
      throw new DnsResolutionError(normalizedName, 'EXPIRED_TTL (Record expired and upstream unreachable)');
    }

    return match;
  }

  private normalizeHostname(name: string): string {
    const cleaned = name.trim().toLowerCase().replace(/\.$/, '');
    if (!cleaned) {
      throw new DnsResolutionError(name, 'INVALID_HOSTNAME (Hostname cannot be empty)');
    }
    return cleaned;
  }
}
