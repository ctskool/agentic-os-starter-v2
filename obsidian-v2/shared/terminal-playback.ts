interface TerminalSurface {cols:number;rows:number;resize:(cols:number,rows:number)=>void;write:(data:string,callback:()=>void)=>void;reset:()=>void}
interface Output {reset?:boolean;data:string;frames?:{cols:number;rows:number;data:string}[]}
// xterm writes are asynchronous. Finish each segment before changing geometry.
export async function replayTerminal(term:TerminalSurface,output:Output,gone:()=>boolean){
  if(gone())return;if(output.reset)term.reset();
  for(const frame of output.frames||[{cols:term.cols,rows:term.rows,data:output.data}]){
    if(gone())return;
    if(frame.cols!==term.cols||frame.rows!==term.rows)term.resize(frame.cols,frame.rows);
    if(frame.data)await new Promise<void>(resolve=>term.write(frame.data,resolve));
  }
}
