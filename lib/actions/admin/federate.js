const config = require('../../config')
const request = require('request')

module.exports = function (req, res) {
    let data = {
        instanceUrl: config.get('instanceUrl'),
        uriPrefix: config.get('databasePrefix'),
        administratorEmail: config.get('administratorEmail'),
        updateEndpoint: 'updateWebOfRegistries',
        name: config.get('instanceUrl'),
        description: config.get('frontPageText')
    }

    let worUrl = req.body.webOfRegistries[-1] != "/" ? req.body.webOfRegistries : req.body.webOfRegistries.substring(0, -1);


    request.post(worUrl + "/instances/new/", {
        json: data
    }, (err, resp, body) => {
        if (err) {
            console.log("Federation error");
            console.log(err);
        } else if(resp.statusCode >= 300) {
            // TODO: Display some kind of error message
            res.redirect('/admin/registries');
        } else {
            config.set('webOfRegistriesSecret', body["updateSecret"]);
            config.set('webOfRegistriesUrl', req.body.webOfRegistries);
            config.set('webOfRegistriesId', body["id"]);

            res.redirect('/admin/registries');
        }
    });
}