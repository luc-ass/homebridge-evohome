var Q = require('q');
var request = require('request');
var _ = require('lodash');

function UserInfo(json) {
    this.userID = json.userId;
    this.username = json.username;
    this.firstname = json.firstname;
    this.lastname = json.lastname;
    this.streetAddress = json.streetAddress;
    this.city = json.city;
    this.postcode = json.postcode;
    this.country = json.country;
    this.language = json.language;
}

// Private
var sessionCredentials = {};

function Session(username, password, json, userinfo) {
    this.sessionId = "bearer " + json.access_token;
    this.refreshToken = json.refresh_token;
    this.refreshTokenInterval = json.expires_in - 30; // refresh token 30 seconds before expiry
    
    this.userInfo = new UserInfo(userinfo);

    sessionCredentials[this.sessionId] = {
        username: username,
        password: password
    };
}

function Location(json) {
    this.locationID = json.locationID;
    this.name = json.name;
    this.streetAddress = json.streetAddress;
    this.city = json.city;
    this.country = json.country;
    this.postcode = json.postcode;
    this.locationType = json.locationType;
    this.devices = _.map(json.devices, function(device) { return new Device(device); });
    this.daylightSavingTimeEnabled = json.daylightSavingTimeEnabled;
    this.timeZone = new Timezone(json.timeZone);
    this.systemId = json.systemId;
}

function Timezone(json) {
    this.timeZoneId = json.timeZoneId;
    this.displayName = json.displayName;
    this.offsetMinutes = json.offsetMinutes;
    this.currentOffsetMinutes = json.currentOffsetMinutes;
    this.supportsDaylightSaving = json.supportsDaylightSaving;
}

function Device(json) {
    this.zoneID = json.zoneId;
    this.zoneType = json.zoneType;
    this.modelType = json.modelType;
    this.name = json.name;
}

function Thermostat(json) {
    this.zoneId = json.zoneId;
    this.name = json.name;
    this.temperatureStatus = new TemperatureStatus(json.temperatureStatus);
    this.setpointStatus = new SetpointStatus(json.setpointStatus);
}

function TemperatureStatus(json) {
    this.temperature = json.temperature;
    this.isAvailable = json.isAvailable;
}

function SetpointStatus(json) {
   this.targetHeatTemperature = json.targetHeatTemperature;
   this.setpointMode = json.setpointMode;
}

function Schedule(json) {
    this.dayOfWeek = json.dayOfWeek;
    this.switchpoints = _.map(json.switchpoints, function(sw) { return new Switchpoint(sw); });
}

function Switchpoint(json) {
    this.heatSetpoint = json.heatSetpoint;
    this.timeOfDay = json.timeOfDay;
}

function SystemModeStatus(json) {
    this.mode = json.mode;
    this.isPermanent = json.isPermanent;
}

Session.prototype.getSchedule = function(zoneId) {
    var url = "https://tccna.honeywell.com/WebAPI/emea/api/v1/temperatureZone/" + zoneId + "/schedule";
    return this._request(url).then(function(json) {
        return _.map(json.dailySchedules, function(s) {
            return new Schedule(s);
        });
    });
}

Session.prototype.getThermostats = function(locationId) {
    var url = "https://tccna.honeywell.com/WebAPI/emea/api/v1/location/" + locationId + "/status?includeTemperatureControlSystems=True";
    return this._request(url).then(function(json) {
        return _.map(json.gateways[0].temperatureControlSystems[0].zones, function(t) {
            return new Thermostat(t);
        });
    });
}

Session.prototype.getSystemModeStatus = function(locationId) {
    var url = "https://tccna.honeywell.com/WebAPI/emea/api/v1/location/" + locationId + "/status?includeTemperatureControlSystems=True";
    return this._request(url).then(function(json) {
        return new SystemModeStatus(json.gateways[0].temperatureControlSystems[0].systemModeStatus);
    });
}

Session.prototype.getLocations = function() {
    var url = "https://tccna.honeywell.com/WebAPI/emea/api/v1/location/installationInfo?userId=" + this.userInfo.userID + "&includeTemperatureControlSystems=True";
    return this._request(url).then(function(json) {
        return _.map(json, function(location) {
            var data = {}
            
            data.locationID = location.locationInfo.locationId;
            data.name = location.locationInfo.name;
            data.streetAddress = location.locationInfo.streetAddress;
            data.city = location.locationInfo.city;
            data.country = location.locationInfo.country;
            data.postcode = location.locationInfo.postcode;
            data.locationType = location.locationInfo.locationType;
            data.daylightSavingTimeEnabled = location.locationInfo.useDaylightSaveSwitching;
            data.timeZone = location.locationInfo.timeZone;
            data.devices = location.gateways[0].temperatureControlSystems[0].zones;
            data.systemId = location.gateways[0].temperatureControlSystems[0].systemId;
            
            return new Location(data);
        });
    });
}



Session.prototype.setHeatSetpoint = function (zoneId, targetTemperature, endtime) {
    var deferred = Q.defer();
    var url = "https://tccna.honeywell.com/WebAPI/emea/api/v1/temperatureZone/" + zoneId + "/heatSetpoint";
    var now = new Date();
    
    if(endtime != null) {
        if(endtime == "00:00:00") {
            now.setDate(now.getDate() + 1);
        }
        var endDateString = now.toDateString() + " " + endtime;
        var endDate = new Date(Date.parse(endDateString));

        var body = JSON.stringify({"HeatSetpointValue":targetTemperature,"SetpointMode":"TemporaryOverride","TimeUntil":endDate});
    } else {
        // if target temperature is set to zero then we ask to follow the schedule instead of setting a temperature
        if(targetTemperature == 0) {
            var body = JSON.stringify({"HeatSetpointValue":0.0,"SetpointMode":"FollowSchedule","TimeUntil":null});
        } else {
            var body = JSON.stringify({"HeatSetpointValue":targetTemperature,"SetpointMode":"PermanentOverride","TimeUntil":null});
        }
    }
    
    request({
            method: 'PUT',
            url: url,
            headers: {
            'Content-Type': 'application/json',
            'Authorization': this.sessionId
            },
            body: body
            }, function (err, response) {
            if (err) {
            deferred.reject(err);
            } else {
            deferred.resolve(JSON.parse(response.body));
            }
            });
    return deferred.promise;
}

Session.prototype.setSystemMode = function (systemId, systemMode) {
    var deferred = Q.defer();
    var url = "https://tccna.honeywell.com/WebAPI/emea/api/v1/temperatureControlSystem/" + systemId + "/mode";
    
    var body = JSON.stringify({"SystemMode":systemMode,"TimeUntil":null,"Permanent":true});
    
    request({
            method: 'PUT',
            url: url,
            headers: {
            'Content-Type': 'application/json',
            'Authorization': this.sessionId
            },
            body: body
            }, function (err, response) {
            if (err) {
            deferred.reject(err);
            } else {
            deferred.resolve(JSON.parse(response.body));
            }
            });
    return deferred.promise;
}

Session.prototype._renew = function() {
    var self = this;

    var deferred = Q.defer();
    request({
        method: 'POST',
        url: 'https://tccna.honeywell.com/Auth/OAuth/Token',
        headers: {
            'Authorization': 'Basic NGEyMzEwODktZDJiNi00MWJkLWE1ZWItMTZhMGE0MjJiOTk5OjFhMTVjZGI4LTQyZGUtNDA3Yi1hZGQwLTA1OWY5MmM1MzBjYg==',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Connection': 'Keep-Alive',
            'Cache-Control': 'no-store no-cache',
            'Pragma': 'no-cache'
        },
        body: 'grant_type=refresh_token&refresh_token=' + self.refreshToken
    }, function(err, response) {
        if(err) {
            deferred.reject(err);
        } else {
            try {
                deferred.resolve(JSON.parse(response.body));
            } catch (e) {
                deferred.reject(e);
            }
        }
    });
    return deferred.promise;
}

Session.prototype._request = function(url) {
    var deferred = Q.defer();
    request({
        method: 'GET',
        url: url,
        headers: {
            'Authorization': this.sessionId
        }
    }, function(err, response) {
        if(err) {
            deferred.reject(err);
        } else {
            var json;
            try {
                json = JSON.parse(response.body);
            } catch(ex) {    
                console.error(ex);
                console.error(response.body);
                console.error(response);
                deferred.reject(ex);
            }
            if(json) {
                deferred.resolve(json);
            }
        }
    });

    return deferred.promise;
}

function login(username, password) {
    var deferred = Q.defer();
    request({
        method: 'POST',
        url: 'https://tccna.honeywell.com/Auth/OAuth/Token',
        headers: {
            'Authorization': 'Basic NGEyMzEwODktZDJiNi00MWJkLWE1ZWItMTZhMGE0MjJiOTk5OjFhMTVjZGI4LTQyZGUtNDA3Yi1hZGQwLTA1OWY5MmM1MzBjYg==',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Connection': 'Keep-Alive',
            'Cache-Control': 'no-store no-cache',
            'Pragma': 'no-cache'
        },
        body: 'grant_type=password&scope=EMEA-V1-Basic EMEA-V1-Anonymous EMEA-V1-Get-Current-User-Account&Username=' + encodeURIComponent(username) + '&Password=' + encodeURIComponent(password)
    }, function(err, response) {
        if(err) {
            deferred.reject(err);
        } else {
            var json;
            try {
                json = JSON.parse(response.body);

                if(json.error != null) {
                    deferred.reject(json.error);
                } else if(json.access_token == null) {
                    deferred.reject("No 'access_token' in " + JSON.stringify(json));
                } else {
                    deferred.resolve(JSON.parse(response.body));
                }
            } catch (e) {
                deferred.reject(e);
            }
        }
    });
    return deferred.promise;
}
    
function getUserInfo(json) {
    var deferred = Q.defer();
    request({
        method: 'GET',
        url: 'https://tccna.honeywell.com/WebAPI/emea/api/v1/userAccount',
        headers: {
            'Authorization': 'bearer ' + json.access_token
        }
    }, function(err, response) {
        if(err) {
            deferred.reject(err);
        } else {
            try {
                deferred.resolve(JSON.parse(response.body));
            } catch (e) {
                deferred.reject(e);
            }
        }
    });
    return deferred.promise;
}

module.exports = {
    login: function(username, password) {
        return login(username, password).then(function(json) {
            return getUserInfo(json).then(function(userinfojson) {
                return new Session(username, password, json, userinfojson);
            });
        });
    }
};
