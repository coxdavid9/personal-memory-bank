function buildSuggestions({ approvalCount=0, reminderCount=0, actionableCount=0, hour=null } = {}) {
  const suggestions=[];
  if(Number(approvalCount)>0) suggestions.push({label:Number(approvalCount)===1?'Review approval':'Review approvals',prompt:'What approvals are waiting for me?'});
  if(Number(reminderCount)>0) suggestions.push({label:"Today’s reminders",prompt:'What do I need to handle today?'});
  if(!suggestions.length && Number(actionableCount)>0 && Number(hour)>=8 && Number(hour)<12) {
    suggestions.push({label:'Plan today',prompt:'Based on what I have going on, what should I focus on today?'});
  }
  return suggestions.slice(0,3);
}
module.exports={buildSuggestions};
