import {createElement} from 'react';
import {ReportMarkdown} from './report-markdown';

// Generated text is content, never document HTML or executable SVG.
export function ArtifactText({text,mime}:{text:string;mime:string}){
 return mime==='text/markdown'?createElement(ReportMarkdown,{markdown:text}):createElement('pre',{className:'artifact-plain'},text||'This file is empty.');
}
