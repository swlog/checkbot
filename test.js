const axios = require("axios");

async function test() {

  const res = await axios.get(
    "https://solved.ac/api/v3/user/show?handle=swlog"
  );

  console.log(res.data);

}

test();