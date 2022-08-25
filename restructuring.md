# 1. Overview

EvohomePlatform.prototype
- login(username, password) returns (session)
  - session.getLocations() returns (locations)
    - session.getThermostats(locations[that.locationIndex].localtionID) returns (thermostats)



# 2. Functions needed
- [ ] login(username, password) => session
- [x] renewSession() => session

## 2.1 login
old
```js
// approximation, as "login" is a wrapper arround other functions
// index.js 102ff
EvohomePlatform.prototype = {
  var that = this
  //...
  evohome
    .login(that.username, that.password)
    .then(
      function (session) {
        //do something with session
      }
    )
    .fail(function(err) {
      that.log.error("Error during login:", err)
      callback([])
    })
}
```
new
```js
EvohomePlatform.prototype.login = async function (callback) { // callback needed?
  let that = this
  let session
  try {
    that.log("Logging into Evohome...")
    session = await evohome.login(that.username, that.password)
    that.log("Logged into Evohome!")
  } catch (err) {
    that.log.error("Error during Login:\n", err)
  } finally {
    //cleanup - return session here?
  }
  return session
}
```