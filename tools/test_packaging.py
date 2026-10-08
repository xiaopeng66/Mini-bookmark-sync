"""Portable marker-gate regressions; no release artifacts or disk fixtures."""
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import packaging as P


LAYOUT_MARKER = 'flex-shrink: 0;\n            white-space: nowrap'


class MarkerNewlineTests(unittest.TestCase):
    def check_archive(self, body, markers):
        archive_bytes = io.BytesIO()
        with zipfile.ZipFile(archive_bytes, 'w') as archive:
            archive.writestr('options.html', body.encode('utf-8'))
        archive_bytes.seek(0)
        with zipfile.ZipFile(archive_bytes) as archive:
            with patch.dict(P.MARKERS, {'options.html': markers}, clear=True):
                return P.check_markers(
                    lambda rel: archive.read(rel).decode('utf-8', 'ignore'))

    def test_layout_marker_accepts_lf_and_crlf_archive_text(self):
        for newline in ('\n', '\r\n'):
            with self.subTest(newline=repr(newline)):
                body = LAYOUT_MARKER.replace('\n', newline)
                self.assertEqual(self.check_archive(body, [LAYOUT_MARKER]), [])

    def test_missing_layout_declaration_is_rejected_for_both_newlines(self):
        for newline in ('\n', '\r\n'):
            with self.subTest(newline=repr(newline)):
                body = 'flex-shrink: 0;' + newline + '            color: red'
                problems = self.check_archive(body, [LAYOUT_MARKER])
                self.assertEqual(len(problems), 1)
                self.assertIn('options.html', problems[0])
                self.assertIn(repr(LAYOUT_MARKER), problems[0])

    def test_forbidden_multiline_marker_is_rejected_for_both_newlines(self):
        for newline in ('\n', '\r\n'):
            with self.subTest(newline=repr(newline)):
                body = LAYOUT_MARKER.replace('\n', newline)
                problems = self.check_archive(body, ['!' + LAYOUT_MARKER])
                self.assertEqual(len(problems), 1)
                self.assertIn(repr(LAYOUT_MARKER), problems[0])

    def test_normalization_does_not_relax_indentation(self):
        body = 'flex-shrink: 0;\r\n white-space: nowrap'
        self.assertEqual(len(self.check_archive(body, [LAYOUT_MARKER])), 1)

    def test_missing_file_still_reports_failure(self):
        def missing_file(rel):
            raise FileNotFoundError(rel)

        with patch.dict(P.MARKERS, {'options.html': [LAYOUT_MARKER]}, clear=True):
            self.assertEqual(P.check_markers(missing_file), ['缺文件 options.html'])


if __name__ == '__main__':
    unittest.main()
