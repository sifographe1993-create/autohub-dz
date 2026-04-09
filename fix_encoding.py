#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fix triple/double encoded UTF-8 characters in src/index.tsx"""
import re

def fix_encoding_str(s):
    """Try to fix double/triple encoded UTF-8 strings."""
    # Try multiple rounds of: encode as cp1252, decode as utf-8
    result = s
    for _ in range(3):
        try:
            fixed = result.encode('cp1252').decode('utf-8')
            if fixed != result:
                result = fixed
            else:
                break
        except Exception:
            break
    return result

# Test first
test_cases = [
    ("Approuv\u00c3\u0192\u00c6\u2019\u00c3\u201a\u00c2\u00a9", "\u00e9"),
]

# Read the file
with open('src/index.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

print(f"File size: {len(content)} characters")

# Check some samples
samples = [
    content[199*100:199*100+200],  # Around line 200
]

# Apply fix
fixed = fix_encoding_str(content)
print(f"Fixed size: {len(fixed)} characters")

# Show some diffs
import difflib
# Find a few spots where the encoding was fixed
for i, (a, b) in enumerate(zip(content[:5000], fixed[:5000])):
    if a != b:
        print(f"Char {i}: {repr(a)} -> {repr(b)}")
        if i > 50:
            break

# Write fixed file
with open('src/index.tsx', 'w', encoding='utf-8') as f:
    f.write(fixed)

print("Done! File written.")
