export function leftTruncate(s: string, len: number): string {
    if (s.length < len) {
        return s;
    } else {
        return "..." + s.substring(s.length - len + 3);
    }
}