#!/usr/bin/env python3
"""Genera lib/fuente_vectorial.js a partir de DejaVu Sans (regular y negrita).

Cada glifo se guarda como ruta SVG (en unidades de la fuente) + ancho de avance.
Así el bot dibuja texto como vectores y no depende de las fuentes del servidor.
DejaVu Sans: licencia libre (Bitstream Vera / DejaVu) que permite redistribuir.
"""
import json
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

RUTAS = {
    "r": "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "b": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
}

def rangos():
    chars = set()
    chars.update(range(0x20, 0x7F))            # ASCII
    chars.update(range(0xA0, 0x100))           # Latin-1 (áéíóúñü¿¡ ² ³ ¹ ° ± × ÷ ½ ¼ ¾ ...)
    chars.update(range(0x391, 0x3AA))          # Griego mayúsculas
    chars.update(range(0x3B1, 0x3CA))          # Griego minúsculas
    chars.update(range(0x2070, 0x209D))        # Super/subíndices
    chars.update(range(0x2150, 0x2160))        # Fracciones
    chars.update(range(0x2190, 0x21A0))        # Flechas
    chars.update([0x21D2, 0x21D4])
    chars.update(range(0x2200, 0x2230))        # Operadores matemáticos
    chars.update([0x2234, 0x2235, 0x2248, 0x2260, 0x2261, 0x2264, 0x2265, 0x2282, 0x2283,
                  0x2286, 0x2287, 0x22A5, 0x2225, 0x2220, 0x221F, 0x25B3, 0x25A1, 0x25CB])
    chars.update([0x2022, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x2032, 0x2033,
                  0x20AC, 0x2030, 0x2103, 0x2109, 0x2713, 0x2714, 0x2717, 0x2718, 0x26A0,
                  0x2115, 0x2124, 0x211A, 0x211D, 0x2102, 0x2211, 0x222B, 0x2202, 0x2206,
                  0x00B7, 0x2218, 0x2223, 0x2016, 0x2308, 0x2309, 0x230A, 0x230B])
    return sorted(chars)

def extraer(ruta):
    fuente = TTFont(ruta)
    cmap = fuente.getBestCmap()
    gs = fuente.getGlyphSet()
    upm = fuente["head"].unitsPerEm
    asc = fuente["hhea"].ascent
    desc = fuente["hhea"].descent
    glifos = {}
    for cp in rangos():
        nombre = cmap.get(cp)
        if not nombre:
            continue
        g = gs[nombre]
        pen = SVGPathPen(gs, ntos=lambda v: str(int(round(v))) if float(v).is_integer() else ("%.1f" % v))
        g.draw(pen)
        d = pen.getCommands()
        glifos[chr(cp)] = {"w": int(round(g.width)), "d": d}
    return {"upm": upm, "asc": asc, "desc": desc, "g": glifos}

def main():
    salida = {k: extraer(v) for k, v in RUTAS.items()}
    cabecera = (
        "// Archivo generado por tools/generar_fuente.py — NO editar a mano.\n"
        "// Glifos de DejaVu Sans (licencia libre Bitstream Vera/DejaVu: permite uso y redistribución;\n"
        "// derivados no pueden llamarse 'Bitstream Vera'). Usados para dibujar texto como vectores,\n"
        "// de modo que las hojas de tareas no dependan de las fuentes instaladas en el servidor.\n"
    )
    with open("lib/fuente_vectorial.js", "w", encoding="utf-8") as f:
        f.write(cabecera)
        f.write("module.exports = ")
        json.dump(salida, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    total = sum(len(v["g"]) for v in salida.values())
    print("glifos totales:", total)

if __name__ == "__main__":
    main()
