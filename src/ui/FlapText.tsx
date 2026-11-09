/**
 * Render mechanical character tiles while retaining ordinary readable DOM text.
 * @param text Complete label; whitespace separates unbroken words.
 * @returns Text spans styled as a static split-flap display.
 */
export function FlapText({ text }: { text: string }) {
  return <span className="flap-text">{text.split(/(\s+)/).map((word, i) => /\s/.test(word)
    ? word : <span className="flap-word" key={i}>{[...word].map((char, j) => <span className="flap-char" key={j}>{char}</span>)}</span>)}</span>;
}
