import { describe, it, expect } from 'vitest';
import { stripMarkdownFormatting } from '../utils/markdownUtils';

describe('stripMarkdownFormatting', () => {
  it('should remove bold formatting', () => {
    expect(stripMarkdownFormatting('**bold text**')).toBe('bold text');
  });

  it('should remove italic formatting', () => {
    expect(stripMarkdownFormatting('*italic text*')).toBe('italic text');
  });

  it('should remove inline code formatting', () => {
    expect(stripMarkdownFormatting('`code`')).toBe('code');
  });

  it('should remove link formatting but keep text', () => {
    expect(stripMarkdownFormatting('[link text](https://example.com)')).toBe('link text');
  });

  it('should remove strikethrough formatting', () => {
    expect(stripMarkdownFormatting('~~strikethrough~~')).toBe('strikethrough');
  });

  it('should remove image formatting but keep alt text', () => {
    expect(stripMarkdownFormatting('![alt text](https://example.com/image.png)')).toBe('alt text');
  });

  it('should handle multiple formatting in one line', () => {
    expect(stripMarkdownFormatting('**bold** and *italic* and `code`')).toBe('bold and italic and code');
  });

  it('should handle nested formatting', () => {
    expect(stripMarkdownFormatting('**bold with *italic* inside**')).toBe('bold with italic inside');
  });

  it('should collapse multiple spaces', () => {
    expect(stripMarkdownFormatting('text   with   multiple   spaces')).toBe('text with multiple spaces');
  });

  it('should trim whitespace', () => {
    expect(stripMarkdownFormatting('  trimmed text  ')).toBe('trimmed text');
  });

  it('should handle empty string', () => {
    expect(stripMarkdownFormatting('')).toBe('');
  });

  it('should handle plain text without formatting', () => {
    expect(stripMarkdownFormatting('plain text')).toBe('plain text');
  });

  it('should handle complex markdown heading', () => {
    const input = '## **Installation** Guide';
    expect(stripMarkdownFormatting(input)).toBe('## Installation Guide');
  });

  it('should handle link with formatting inside', () => {
    const input = '[**bold link**](https://example.com)';
    expect(stripMarkdownFormatting(input)).toBe('bold link');
  });

  it('should handle Chinese characters', () => {
    // Chinese for "bold Chinese text"
    expect(stripMarkdownFormatting('**\u4e2d\u6587\u52a0\u7c97**')).toBe('\u4e2d\u6587\u52a0\u7c97');
    // Chinese for "link text"
    expect(stripMarkdownFormatting('[\u94fe\u63a5\u6587\u672c](https://example.com)')).toBe('\u94fe\u63a5\u6587\u672c');
  });
});
