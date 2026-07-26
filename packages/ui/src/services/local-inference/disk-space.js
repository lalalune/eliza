/**
 * Disk-space probing (statfs) and download advice: warns low/critical against a
 * safety margin so a model download never fills the volume.
 */
import { statfsSync } from "node:fs";
const BYTES_PER_GB = 1024 ** 3;
const DOWNLOAD_SAFETY_MARGIN_BYTES = 2 * BYTES_PER_GB;
const LOW_DISK_MULTIPLIER = 1.5;
export async function probeDiskSpace(path) {
    const stats = statfsSync(path);
    const blockSize = Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * blockSize;
    const _freeBytes = Number(stats.bfree) * blockSize;
    const availableBytes = Number(stats.bavail) * blockSize;
    return {
        path,
        totalBytes,
        freeBytes: availableBytes,
        availableBytes,
    };
}
export function adviseDiskSpace(probe, modelSizeBytes) {
    const requiredBytes = modelSizeBytes + DOWNLOAD_SAFETY_MARGIN_BYTES;
    const recommendedFreeBytes = Math.ceil(modelSizeBytes * LOW_DISK_MULTIPLIER);
    const freeBytes = probe.freeBytes;
    if (freeBytes < requiredBytes) {
        return { warning: "critical-disk", requiredBytes, recommendedFreeBytes };
    }
    if (freeBytes < recommendedFreeBytes) {
        return { warning: "low-disk", requiredBytes, recommendedFreeBytes };
    }
    return { requiredBytes, recommendedFreeBytes };
}
