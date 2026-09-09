/** Public deterministic fixture. Known finite program priors, not a trained model.
 * This standalone bundle is copied into a restricted child process. */
export function createAgent(mode){
  let scale=1,offset=0;
  return {
    learn(examples){
      if(mode!=='baseline'){
        if(!Array.isArray(examples)||examples.length<2)throw Error('insufficient_support');
        const [a,b]=examples;
        if(a.input.kind!=='affine'||b.input.kind!=='affine'||a.input.x===b.input.x)throw Error('invalid_support');
        const nextScale=(b.output-a.output)/(b.input.x-a.input.x),nextOffset=a.output-nextScale*a.input.x;
        if(!Number.isFinite(nextScale)||!Number.isFinite(nextOffset)||Math.abs(nextScale)>10||Math.abs(nextOffset)>100)throw Error('invalid_model');
        scale=nextScale;offset=nextOffset;
      }
      return {samples:examples.length};
    },
    predict(input){
      if(!input||!Number.isFinite(input.x))throw Error('invalid_input');
      if(input.kind==='affine')return scale*input.x+offset;
      if(input.kind==='square')return input.x*input.x;
      throw Error('unknown_family');
    },
    snapshot(){return {version:1,scale,offset};},
    restore(state){
      if(state?.version!==1||!Number.isFinite(state.scale)||Math.abs(state.scale)>10||!Number.isFinite(state.offset)||Math.abs(state.offset)>100)throw Error('invalid_state');
      scale=state.scale;offset=state.offset;return {restored:true};
    },
  };
}
