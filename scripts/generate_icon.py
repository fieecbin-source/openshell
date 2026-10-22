import zlib
import struct
import math

def make_png(width, height):
    # RGBA image
    raw = bytearray()
    for y in range(height):
        raw.append(0) # filter byte 0
        ny = (y - height / 2) / (height / 2)
        for x in range(width):
            nx = (x - width / 2) / (width / 2)
            dist_sq = nx * nx + ny * ny
            
            # Rounded rect background
            # corner radius approx 0.85
            cx = max(0, abs(nx) - 0.7)
            cy = max(0, abs(ny) - 0.7)
            corner_dist = math.sqrt(cx * cx + cy * cy)
            
            if corner_dist > 0.25:
                # Transparent
                raw.extend([0, 0, 0, 0])
            else:
                # Dark slate gradient background
                alpha = 255
                if corner_dist > 0.22:
                    alpha = int(255 * (0.25 - corner_dist) / 0.03)
                
                # Terminal icon: draw '>' chevron and '_' prompt
                # Coordinates normalized 0..1 inside inner box (width 512)
                px = x / width
                py = y / height
                
                is_chevron = False
                # Top slant of '>': from (0.28, 0.32) to (0.45, 0.48)
                # Bottom slant of '>': from (0.45, 0.48) to (0.28, 0.64)
                if 0.26 <= px <= 0.48 and 0.30 <= py <= 0.66:
                    d1 = abs((py - 0.32) - (px - 0.28))
                    d2 = abs((0.64 - py) - (px - 0.28))
                    if (py <= 0.48 and d1 < 0.045) or (py >= 0.48 and d2 < 0.045):
                        is_chevron = True
                
                # Cursor '_' at (0.52 <= px <= 0.72, 0.60 <= py <= 0.65)
                is_cursor = (0.52 <= px <= 0.72 and 0.60 <= py <= 0.65)
                
                if is_chevron:
                    # Electric Cyan
                    raw.extend([0, 229, 255, alpha])
                elif is_cursor:
                    # Electric Violet
                    raw.extend([124, 77, 255, alpha])
                else:
                    # Dark navy glass background (#101420 -> #182033)
                    t = (nx + ny + 2) / 4
                    r = int(14 + 12 * t)
                    g = int(18 + 16 * t)
                    b = int(28 + 26 * t)
                    raw.extend([r, g, b, alpha])
                    
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    header = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    idat = chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    iend = chunk(b'IEND', b'')
    return header + ihdr + idat + iend

if __name__ == '__main__':
    with open('app-icon.png', 'wb') as f:
        f.write(make_png(512, 512))
    print("Generated 512x512 app-icon.png successfully.")
