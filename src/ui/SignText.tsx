import { Fragment } from 'react';

/** Keep whole words together when they fit; provide balanced, readable breaks for
 * words wider than a sign at enlarged text sizes. Text/copy/accessibility stay intact. */
export function SignText({ text }: { text: string }) {
  return text.split(/(\s+)/).map((word, index) => {
    if (!word.trim()) return word;
    const characters = Array.from(word);
    const count = Math.ceil(characters.length / 4);
    return <span className="sign-word" key={index}>{Array.from({ length: count }, (_, part) => <Fragment key={part}>
      {part > 0 && <wbr />}
      <span className="sign-word-part">{characters.slice(Math.floor(part * characters.length / count), Math.floor((part + 1) * characters.length / count)).join('')}</span>
    </Fragment>)}</span>;
  });
}

